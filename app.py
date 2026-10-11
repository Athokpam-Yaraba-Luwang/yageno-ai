# SPDX-FileCopyrightText: Copyright (C) 2026 Athokpam Yaraba Luwang
# SPDX-License-Identifier: AGPL-3.0-or-later

import os
import re
import json
import uuid
import time
import hmac
from datetime import datetime, timezone, timedelta
from decimal import Decimal

import boto3
import botocore.exceptions
import uvicorn
from boto3.dynamodb.conditions import Attr, Key
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from mangum import Mangum

from system_prompt import build_system_prompt

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = FastAPI()
app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))

# ---------------------------------------------------------------------------
# AWS
#   YagenoChats  : chats, user records (USER#name) and the latest device record (DEVICE#mark1). Unchanged.
#   YagenoStream : NEW. Time series + shared chat.   partition key: pk (String)   sort key: ts (Number, ms)
#        pk = dev#mark1   every sensor/actuator reading   (history, RAG)
#        pk = ev#mark1    detections and actuator commands (RAG)
#        pk = chat#farm   the shared farm chat (users, AI, notices, automated decisions)
#        pk = lock#farm   one row, ts = 0: the "one AI" lock
#   Turn on TTL for the attribute "exp" on YagenoStream so old rows delete themselves.
# ---------------------------------------------------------------------------
bedrock = boto3.client('bedrock-runtime', region_name='ap-southeast-2')
dynamodb = boto3.resource('dynamodb', region_name='ap-southeast-2')
chat_table = dynamodb.Table('YagenoChats')
stream_table = dynamodb.Table(os.environ.get("STREAM_TABLE", "YagenoStream"))

MODEL_ID = "au.anthropic.claude-haiku-4-5-20251001-v1:0"
LOCAL_TZ = timezone(timedelta(minutes=int(os.environ.get("LOCAL_TZ_OFFSET_MIN", "330"))))   # IST
KEEP_SECONDS = 30 * 86400

THEME_IDS = {"green", "blue", "pink", "wood", "grey", "lavender",
             "dark-green", "dark-blue", "dark-pink", "dark-wood", "dark-grey", "dark-lavender"}
PROJECTS = {"farm"}
USERNAME_RE = re.compile(r'^[a-z0-9_]{3,20}$')
CONDITIONAL_FAIL = "ConditionalCheckFailedException"


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def now_ms():
    return int(time.time() * 1000)


def to_py(v):
    """DynamoDB returns Decimal; turn everything into plain int/float/str."""
    if isinstance(v, Decimal):
        return int(v) if v == v.to_integral_value() else float(v)
    if isinstance(v, dict):
        return {k: to_py(x) for k, x in v.items()}
    if isinstance(v, list):
        return [to_py(x) for x in v]
    return v


def fmt_when(ms):
    return datetime.fromtimestamp(ms / 1000, LOCAL_TZ).strftime("%a %d %b %H:%M:%S")


def fmt_secs(s):
    s = int(s)
    if s < 60:
        return f"{s} seconds"
    m = s // 60
    return f"{m} minute" + ("s" if m != 1 else "")


def error_code(e):
    return e.response.get("Error", {}).get("Code", "")


# ---------------------------------------------------------------------------
# Identity (demo-grade): X-Username / X-Project headers. No password.
# ---------------------------------------------------------------------------
def user_key(name):
    return f"USER#{name}"


def current_user(request: Request):
    name = (request.headers.get("x-username") or "").strip().lower()
    return name if USERNAME_RE.match(name) else None


def current_project(request: Request):
    p = (request.headers.get("x-project") or "farm").strip().lower()
    return p if p in PROJECTS else "farm"


def unauthorized():
    return JSONResponse(status_code=401, content={"text": "Sign in first."})


def user_exists(name):
    return 'Item' in chat_table.get_item(Key={'sessionId': user_key(name)})


@app.get("/")
def read_root(request: Request):
    return templates.TemplateResponse(request=request, name="index.html")


# ---------- users ----------
@app.get("/api/users/check")
async def check_username(name: str = ""):
    name = name.strip().lower()
    if not USERNAME_RE.match(name):
        return {"valid": False, "available": False}
    try:
        return {"valid": True, "available": not user_exists(name)}
    except Exception as e:
        print(f"User check error: {e}")
        return JSONResponse(status_code=500, content={"status": "error"})


@app.post("/api/users/claim")
async def claim_username(request: Request):
    data = await request.json()
    name = str(data.get("username", "")).strip().lower()
    if not USERNAME_RE.match(name):
        return JSONResponse(status_code=400, content={"status": "invalid"})
    try:
        chat_table.put_item(
            Item={'sessionId': user_key(name), 'uname': name, 'createdAt': now_iso()},
            ConditionExpression="attribute_not_exists(sessionId)",
        )
        return {"status": "success", "username": name}
    except botocore.exceptions.ClientError as e:
        if error_code(e) == CONDITIONAL_FAIL:
            return JSONResponse(status_code=409, content={"status": "taken"})
        print(f"Claim error: {e}")
        return JSONResponse(status_code=500, content={"status": "error"})


@app.post("/api/users/login")
async def login_username(request: Request):
    data = await request.json()
    name = str(data.get("username", "")).strip().lower()
    if not USERNAME_RE.match(name):
        return JSONResponse(status_code=400, content={"status": "invalid"})
    try:
        item = chat_table.get_item(Key={'sessionId': user_key(name)}).get('Item')
        if item:
            return {"status": "success", "username": name, "theme": item.get('theme')}
        return JSONResponse(status_code=404, content={"status": "not_found"})
    except Exception as e:
        print(f"Login error: {e}")
        return JSONResponse(status_code=500, content={"status": "error"})


@app.post("/api/users/theme")
async def save_theme(request: Request):
    user = current_user(request)
    if not user:
        return unauthorized()
    data = await request.json()
    theme = str(data.get("theme", ""))
    if theme not in THEME_IDS:
        return JSONResponse(status_code=400, content={"status": "invalid"})
    try:
        chat_table.update_item(
            Key={'sessionId': user_key(user)},
            UpdateExpression="SET #t = :t",
            ConditionExpression="attribute_exists(sessionId)",
            ExpressionAttributeNames={'#t': 'theme'},
            ExpressionAttributeValues={':t': theme},
        )
        return {"status": "success"}
    except botocore.exceptions.ClientError as e:
        if error_code(e) == CONDITIONAL_FAIL:
            return JSONResponse(status_code=404, content={"status": "not_found"})
        print(f"Theme save error: {e}")
        return JSONResponse(status_code=500, content={"status": "error"})


# ---------- personal chats (scoped to the signed-in username) ----------
@app.get("/api/chats")
async def get_chats(request: Request):
    user = current_user(request)
    if not user:
        return unauthorized()
    try:
        items = []
        kwargs = {
            "ProjectionExpression": "sessionId, title, updatedAt, pinned",
            "FilterExpression": Attr('username').eq(user) & Attr('project').eq(current_project(request)),
        }
        while True:
            response = chat_table.scan(**kwargs)
            items.extend(response.get('Items', []))
            if 'LastEvaluatedKey' not in response:
                break
            kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']
        items.sort(key=lambda x: (str(x.get('pinned', 'false')).lower() == 'true', x.get('updatedAt', '')), reverse=True)
        return {"chats": items}
    except Exception as e:
        print(f"DynamoDB Scan Error: {e}")
        return {"chats": []}


@app.get("/api/chats/{session_id}")
async def get_chat_history(session_id: str, request: Request):
    user = current_user(request)
    if not user:
        return unauthorized()
    try:
        item = chat_table.get_item(Key={'sessionId': session_id}).get('Item')
        if item and item.get('username') == user:
            return {"messages": item.get('messages', [])}
        return {"messages": []}
    except Exception as e:
        print(f"DynamoDB GetItem Error: {e}")
        return {"messages": []}


@app.patch("/api/chats/{session_id}")
async def update_chat(session_id: str, request: Request):
    user = current_user(request)
    if not user:
        return unauthorized()
    data = await request.json()
    update_expr, expr_attrs = [], {':u': user}
    if "title" in data:
        update_expr.append("title = :t")
        expr_attrs[':t'] = data['title']
    if "pinned" in data:
        update_expr.append("pinned = :p")
        expr_attrs[':p'] = str(data['pinned']).lower()
    if not update_expr:
        return {"status": "no_update"}
    try:
        chat_table.update_item(
            Key={'sessionId': session_id},
            UpdateExpression="SET " + ", ".join(update_expr),
            ConditionExpression="username = :u",
            ExpressionAttributeValues=expr_attrs,
        )
        return {"status": "success"}
    except botocore.exceptions.ClientError as e:
        if error_code(e) == CONDITIONAL_FAIL:
            return JSONResponse(status_code=404, content={"status": "not_found"})
        print(f"DynamoDB Update Error: {e}")
        return JSONResponse(status_code=500, content={"status": "error"})


@app.delete("/api/chats/{session_id}")
async def delete_chat(session_id: str, request: Request):
    user = current_user(request)
    if not user:
        return unauthorized()
    try:
        chat_table.delete_item(
            Key={'sessionId': session_id},
            ConditionExpression="username = :u",
            ExpressionAttributeValues={':u': user},
        )
        return {"status": "success"}
    except botocore.exceptions.ClientError as e:
        if error_code(e) == CONDITIONAL_FAIL:
            return JSONResponse(status_code=404, content={"status": "not_found"})
        print(f"DynamoDB Delete Error: {e}")
        return JSONResponse(status_code=500, content={"status": "error"})


@app.post("/api/chats/{session_id}/branch")
async def branch_chat(session_id: str, request: Request):
    user = current_user(request)
    if not user:
        return unauthorized()
    try:
        old_item = chat_table.get_item(Key={'sessionId': session_id}).get('Item')
        if not old_item or old_item.get('username') != user:
            return JSONResponse(status_code=404, content={"status": "not_found"})
        new_id = str(uuid.uuid4())
        new_title = f"Branch · {old_item.get('title', 'Chat')}"[:40]
        chat_table.put_item(Item={
            'sessionId': new_id, 'username': user, 'project': old_item.get('project', current_project(request)),
            'title': new_title, 'updatedAt': now_iso(), 'messages': old_item.get('messages', []), 'pinned': 'false',
        })
        return {"status": "success", "sessionId": new_id, "title": new_title}
    except Exception as e:
        print(f"DynamoDB Branch Error: {e}")
        return JSONResponse(status_code=500, content={"status": "error"})


@app.post("/api/chats/{session_id}/share")
async def share_chat(session_id: str, request: Request):
    user = current_user(request)
    if not user:
        return unauthorized()
    try:
        chat_table.update_item(
            Key={'sessionId': session_id},
            UpdateExpression="SET #shared = :s",
            ConditionExpression="#username = :u",
            ExpressionAttributeNames={"#shared": "shared", "#username": "username"},
            ExpressionAttributeValues={':s': 'true', ':u': user},
        )
        return {"status": "success", "shareId": session_id}
    except botocore.exceptions.ClientError as e:
        if error_code(e) == CONDITIONAL_FAIL:
            return JSONResponse(status_code=404, content={"status": "not_found"})
        print(f"DynamoDB Share Error: {e}")
        return JSONResponse(status_code=500, content={"status": "error"})


@app.post("/api/share/{share_id}/import")
async def import_shared(share_id: str, request: Request):
    user = current_user(request)
    if not user:
        return unauthorized()
    try:
        src = chat_table.get_item(Key={'sessionId': share_id}).get('Item')
        if not src or str(src.get('shared', 'false')) != 'true' or not src.get('username'):
            return JSONResponse(status_code=404, content={"status": "not_found"})
        if src['username'] == user:
            return {"status": "success", "sessionId": share_id, "title": src.get('title', 'Chat'), "own": True}
        new_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"yageno:{user}:{share_id}"))
        existing = chat_table.get_item(Key={'sessionId': new_id}).get('Item')
        if existing:
            return {"status": "success", "sessionId": new_id, "title": existing.get('title', 'Shared chat'), "own": False}
        new_title = f"Shared · {src.get('title', 'Chat')}"[:40]
        chat_table.put_item(Item={
            'sessionId': new_id, 'username': user, 'project': current_project(request), 'title': new_title,
            'updatedAt': now_iso(), 'messages': src.get('messages', []), 'pinned': 'false', 'sharedFrom': share_id,
        })
        return {"status": "success", "sessionId": new_id, "title": new_title, "own": False}
    except Exception as e:
        print(f"DynamoDB Import Error: {e}")
        return JSONResponse(status_code=500, content={"status": "error"})



# ===========================================================================
# STREAM TABLE helpers (history + shared chat)
# ===========================================================================
def stream_put(pk, item, ts=None):
    """Insert one row; if two rows land on the same millisecond, bump ts by 1."""
    ts = ts or now_ms()
    for _ in range(6):
        try:
            stream_table.put_item(
                Item={'pk': pk, 'ts': ts, **item},
                ConditionExpression="attribute_not_exists(#t)",
                ExpressionAttributeNames={'#t': 'ts'},
            )
            return ts
        except botocore.exceptions.ClientError as e:
            if error_code(e) != CONDITIONAL_FAIL:
                raise
            ts += 1
    raise RuntimeError("stream_put: too many collisions")


def stream_query(pk, start, end, desc=False, limit=5000):
    items = []
    kwargs = {"KeyConditionExpression": Key('pk').eq(pk) & Key('ts').between(start, end), "ScanIndexForward": not desc}
    while len(items) < limit:
        kwargs["Limit"] = min(1000, limit - len(items))
        r = stream_table.query(**kwargs)
        items.extend(r.get('Items', []))
        if 'LastEvaluatedKey' not in r:
            break
        kwargs['ExclusiveStartKey'] = r['LastEvaluatedKey']
    return items[:limit]


CHAT = "chat#farm"
LOCK = "lock#farm"


def post_chat(kind, text, **extra):
    """kind: user | ai | sys (notice) | auto (automated decision). sys notices carry level: alert | info."""
    item = {'kind': kind, 'text': text, 'user': extra.pop('user', 'Yageno AI' if kind == 'ai' else 'Mark 1'),
            'exp': int(time.time()) + KEEP_SECONDS}
    item.update({k: v for k, v in extra.items() if v is not None})
    return stream_put(CHAT, item)


def fmt_age(s):
    s = max(0, int(s))
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m {s % 60}s"
    if s < 86400:
        return f"{s // 3600}h {(s % 3600) // 60}m"
    return f"{s // 86400}d {(s % 86400) // 3600}h"


# ===========================================================================
# DEVICES  (Mark 1 <-> AWS)
# ===========================================================================
DEVICE_KEY = os.environ.get("DEVICE_KEY", "")
DEVICE_IDS = {"mark1"}
STALE_AFTER = 20         # seconds without a reading = offline
CMD_TTL = 15             # a command is re-offered to Mark 1 for this long (it runs each id once)
NOTE_GAP = 60            # at most one chat notice per hazard type per minute (sensors can flicker)
AUTO_COOLDOWN = 60       # seconds between automated AI decisions
STORE_EVERY = 3 * 3600   # a full reading is stored at least every 3 hours ...
                         # ... and also whenever something changes or an anomaly starts/ends
TEMP_HIGH = 32           # same comfort range as the sketch and the Devices page
MOIST_DRY = 30           # % : the ESP32 starts irrigating at about this level

SENSOR_FIELDS = ("fire", "aerial", "sound", "security", "day", "moist", "irrigate", "temp",
                 "hum", "sprinkler", "ctl", "angle", "alarm", "esp")      # no raw fence value, by design
DISCRETE = ("fire", "aerial", "sound", "security", "irrigate", "sprinkler", "alarm", "ctl", "esp", "day")
ESP_FIELDS = {"temp", "hum", "moist", "day", "irrigate"}
ACTUATORS = ("irrigation", "sprinkler", "servo", "alarm")
DURATIONS = {5, 60, 600}
HAZARD_TEXT = {"fire": "Flame detected on the farm",
               "aerial": "Aerial radar: something airborne, possibly birds",
               "sound": "Bird sound detected",
               "security": "Security fence breached: the wire was touched"}


def device_key(device_id):
    return f"DEVICE#{device_id}"


def clean_reading(state):
    out = {}
    for k in SENSOR_FIELDS:
        try:
            out[k] = int(state.get(k, 0))
        except (TypeError, ValueError):
            out[k] = 0
    return out


def pending_commands(item, now):
    out = []
    for a in ACTUATORS:
        c = item.get(f"cmd_{a}")
        if not c or now - int(c.get("at", 0)) > CMD_TTL:
            continue
        out.append({
            "id": c["id"], "actuator": a, "action": c.get("action"),
            "seconds": int(c.get("seconds", 0)),
            "angle": int(c["angle"]) if c.get("angle") is not None else None,
        })
    return out


def anomalies(r):
    """Numeric conditions worth recording when they start or end."""
    out = set()
    if r and r.get("esp"):
        if r.get("temp", 0) > TEMP_HIGH:
            out.add("heat")
        if r.get("moist", 100) <= MOIST_DRY:
            out.add("dry")
    return out


def _recent_cmd(old, actuator, now, action="on", window=25):
    c = old.get(f"cmd_{actuator}")
    if c and c.get("action") == action and now - int(c.get("at", 0)) <= window:
        return c
    return None


def after_state(device_id, key, reading, old, now):
    """History rows, events and farm-chat notices for one reading. Never breaks the ingest."""
    try:
        prev = to_py(old.get('reading')) if old.get('reading') else None
        p = prev or {}
        prev_at = int(old.get('receivedAt', 0))
        came_online = prev is None or now - prev_at > STALE_AFTER
        exp = now + KEEP_SECONDS
        ev = f"ev#{device_id}"
        sets = {}

        changed = [] if prev is None else [k for k in DISCRETE if int(reading.get(k, 0)) != int(p.get(k, 0))]
        a_now, a_prev = anomalies(reading), anomalies(prev)
        started, ended = a_now - a_prev, (a_prev - a_now) if prev else set()

        # ---- storage: every 3 hours, plus on any change / anomaly / coming online ----
        due = now - int(old.get('lastStore', 0)) >= STORE_EVERY
        if came_online or due or changed or started or ended:
            why = ("online" if came_online else "change" if changed else "anomaly" if (started or ended) else "every 3 hours")
            stream_put(f"dev#{device_id}", {'kind': 'reading', 'r': reading, 'why': why,
                                            'changed': changed + sorted(started | ended), 'exp': exp})
            sets['lastStore'] = now

        # ---- events (always) + notices (rate limited per type) ----
        notes = []            # (type, text, level alert|info|event, gap seconds). "event" = history only, no chat notice

        def event(typ, text):
            stream_put(ev, {'kind': 'event', 'type': typ, 'text': text, 'exp': exp})

        if came_online:
            text = "Mark 1 is online" + (f" again after {fmt_age(now - prev_at)}" if prev_at else "")
            notes.append(("online", text, "info", 0))

        for k, text in HAZARD_TEXT.items():
            if reading.get(k) and not p.get(k):
                notes.append((k, text, "alert", NOTE_GAP))
        if prev is not None and p.get("security") and not reading.get("security"):
            notes.append(("security_ok", "Fence is secure again", "info", NOTE_GAP))

        if prev is not None:
            esp_ok = reading.get("esp") and p.get("esp")
            if esp_ok and "irrigate" in changed:
                if reading.get("irrigate"):
                    c = _recent_cmd(old, "irrigation", now)
                    text = (f"Irrigation is on, forced by @{c.get('by')} for {fmt_secs(c.get('seconds', 0))}" if c else
                            f"Irrigation turned on automatically: soil moisture is {reading.get('moist')}%")
                    notes.append(("irrigate", text, "event" if c else "info", 10))   # a forced run was already announced
                else:
                    notes.append(("irrigate", "Irrigation is off", "info", 10))
            if "sprinkler" in changed:
                if reading.get("sprinkler"):
                    c = _recent_cmd(old, "sprinkler", now)
                    by = "Yageno AI (automated)" if c and c.get("by") == "yageno" else (f"@{c.get('by')}" if c else None)
                    text = (f"Sprinkler is on, started by {by} for {fmt_secs(c.get('seconds', 0))}" if c else
                            "Sprinkler started on Mark 1")
                    notes.append(("sprinkler", text, "event" if c else "info", 0))
                else:
                    notes.append(("sprinkler", "Sprinkler stopped", "info", 0))
            if "alarm" in changed:
                if reading.get("alarm"):
                    c = _recent_cmd(old, "alarm", now)
                    by = "Yageno AI (automated)" if c and c.get("by") == "yageno" else (f"@{c.get('by')}" if c else None)
                    notes.append(("alarm", f"Alarm is playing, started by {by}" if c else
                                  "Alarm is playing (joystick button on Mark 1)", "event" if c else "alert", 0))
                else:
                    notes.append(("alarm", "Alarm stopped", "info", 0))
            if "ctl" in changed:
                if reading.get("ctl") == 1:
                    notes.append(("joystick", "Someone is steering the sprinkler with the joystick on Mark 1", "info", NOTE_GAP))
                elif p.get("ctl") == 1:
                    notes.append(("joystick_off", "Joystick released, the servo is back to automatic", "info", NOTE_GAP))
            if "esp" in changed:
                if reading.get("esp"):
                    notes.append(("esp_ok", "ESP32 link restored: temperature, humidity, soil and irrigation are back", "info", 30))
                else:
                    notes.append(("esp", "ESP32 link lost: temperature, humidity, soil and irrigation are unavailable", "alert", 30))
            if "heat" in started:
                notes.append(("heat", f"High temperature: {reading.get('temp')} °C, above {TEMP_HIGH} °C", "alert", 600))
            if "heat" in ended:
                notes.append(("heat_ok", f"Temperature is back to {reading.get('temp')} °C", "info", 600))
            if "day" in changed and reading.get("esp") and p.get("esp"):
                event("day", "Daylight" if reading.get("day") else "Night")

        for typ, text, level, gap in notes:
            event(typ, text)
            if level == "event":            # already announced by the command itself
                continue
            attr = f"note_{typ}"
            if not gap or now - int(old.get(attr, 0)) >= gap:
                post_chat('sys', text, level=level, ntype=typ)
                sets[attr] = now

        if sets:
            names = {f"#a{i}": k for i, k in enumerate(sets)}
            values = {f":v{i}": v for i, v in enumerate(sets.values())}
            chat_table.update_item(Key=key, UpdateExpression="SET " + ", ".join(f"#a{i} = :v{i}" for i in range(len(sets))),
                                   ExpressionAttributeNames=names, ExpressionAttributeValues=values)
    except Exception as e:
        print(f"History/event error: {e}")


def check_offline(item, now):
    """Called while people poll: posts 'Mark 1 went offline' once per disconnect."""
    try:
        if not item or 'receivedAt' not in item:
            return
        seen = int(item['receivedAt'])
        if now - seen <= STALE_AFTER or int(item.get('offNoted', 0)) >= seen:
            return
        chat_table.update_item(Key={'sessionId': item['sessionId']}, UpdateExpression="SET offNoted = :s",
                               ConditionExpression="attribute_not_exists(offNoted) OR offNoted < :s",
                               ExpressionAttributeValues={':s': seen})
        when = datetime.fromtimestamp(seen, LOCAL_TZ).strftime("%H:%M")
        text = f"Mark 1 went offline (last seen at {when} IST)"
        stream_put(f"ev#{item.get('deviceId', 'mark1')}", {'kind': 'event', 'type': 'offline', 'text': text,
                                                          'exp': now + KEEP_SECONDS})
        post_chat('sys', text, level='alert', ntype='offline')
    except botocore.exceptions.ClientError as e:
        if error_code(e) != CONDITIONAL_FAIL:
            print(f"Offline check error: {e}")
    except Exception as e:
        print(f"Offline check error: {e}")


@app.post("/api/device/ingest")
async def device_ingest(request: Request):
    sent = request.headers.get("x-device-key", "")
    if not DEVICE_KEY or not hmac.compare_digest(sent.encode(), DEVICE_KEY.encode()):
        return JSONResponse(status_code=401, content={"status": "unauthorized"})
    try:
        data = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"status": "bad_json"})

    device_id = str(data.get("deviceId", "mark1")).strip().lower()
    if device_id not in DEVICE_IDS:
        return JSONResponse(status_code=400, content={"status": "unknown_device"})

    now = int(time.time())
    key = {'sessionId': device_key(device_id)}
    try:
        state = data.get("state")
        if isinstance(state, dict):
            reading = clean_reading(state)
            old = chat_table.update_item(
                Key=key,
                UpdateExpression="SET deviceId = :d, reading = :r, receivedAt = :t",
                ExpressionAttributeValues={':d': device_id, ':r': reading, ':t': now},
                ReturnValues="ALL_OLD",
            ).get("Attributes", {})
            after_state(device_id, key, reading, old, now)
            item = old                      # cmd_* attributes are not touched by the update above
        else:
            item = chat_table.get_item(Key=key, ConsistentRead=True).get("Item") or {}
        return {"status": "ok", "commands": pending_commands(item, now)}
    except Exception as e:
        print(f"Device ingest error: {e}")
        return JSONResponse(status_code=500, content={"status": "error"})


def device_view(device_id, item, now):
    if not item or 'reading' not in item:
        return {"id": device_id, "online": False, "ageSec": None, "reading": None, "cmds": {}}
    age = max(0, now - int(item.get('receivedAt', 0)))
    cmds = {}
    for a in ACTUATORS:
        c = item.get(f"cmd_{a}")
        if c:
            cmds[a] = {"action": c.get("action"), "seconds": int(c.get("seconds", 0)),
                       "angle": int(c["angle"]) if c.get("angle") is not None else None,
                       "by": c.get("by"), "ageSec": max(0, now - int(c.get("at", 0)))}
    return {"id": device_id, "online": age <= STALE_AFTER, "ageSec": age,
            "reading": {k: int(v) for k, v in item['reading'].items()}, "cmds": cmds}


@app.get("/api/devices")
async def get_devices(request: Request):
    user = current_user(request)
    if not user:
        return unauthorized()
    try:
        now = int(time.time())
        devices = []
        for device_id in sorted(DEVICE_IDS):
            item = chat_table.get_item(Key={'sessionId': device_key(device_id)}).get('Item')
            check_offline(item, now)
            devices.append(device_view(device_id, item, now))
        return {"devices": devices}
    except Exception as e:
        print(f"Devices read error: {e}")
        return JSONResponse(status_code=500, content={"status": "error"})


def describe_command(actuator, action, cmd):
    name = {"irrigation": "the irrigation", "sprinkler": "the sprinkler", "servo": "the sprinkler servo", "alarm": "the alarm"}[actuator]
    if actuator in ("irrigation", "sprinkler"):
        return f"turned on {name} for {fmt_secs(cmd['seconds'])}" if action == "on" else f"turned off {name}"
    if actuator == "servo":
        return f"moved the sprinkler servo to {cmd['angle']}°" if action == "angle" else "gave the servo back to automatic control"
    return "started the alarm" if action == "on" else "stopped the alarm"


def queue_command(device_id, actuator, action, user, seconds=None, angle=None, via="web"):
    """Validate and queue one actuator command for Mark 1. Used by the Devices page and by Yageno AI.
    Returns {"ok": True, "id", "text"} or {"ok": False, "status", "message"}."""
    if device_id not in DEVICE_IDS or actuator not in ACTUATORS:
        return {"ok": False, "status": "invalid", "message": "Unknown device or actuator."}
    cmd = {"id": uuid.uuid4().hex[:12], "action": action, "by": user, "at": int(time.time()), "via": via}
    try:
        if actuator in ("irrigation", "sprinkler"):
            if action == "on":
                seconds = int(seconds or 0)
                if seconds not in DURATIONS:
                    return {"ok": False, "status": "invalid_duration", "message": "Only 5 seconds, 1 minute or 10 minutes."}
                cmd["seconds"] = seconds
            elif action != "off":
                return {"ok": False, "status": "invalid", "message": "Use on or off."}
        elif actuator == "servo":
            if action == "angle":
                angle = int(angle if angle is not None else -1)
                if not 0 <= angle <= 180:
                    return {"ok": False, "status": "invalid_angle", "message": "The angle must be 0 to 180 degrees."}
                cmd["angle"] = angle
            elif action != "release":
                return {"ok": False, "status": "invalid", "message": "Use angle or release."}
        elif actuator == "alarm" and action not in ("on", "off"):
            return {"ok": False, "status": "invalid", "message": "Use on or off."}
    except (TypeError, ValueError):
        return {"ok": False, "status": "invalid", "message": "Invalid value."}

    key = {'sessionId': device_key(device_id)}
    item = chat_table.get_item(Key=key).get('Item')
    now = int(time.time())
    age = (now - int(item.get('receivedAt', 0))) if item else None
    if age is None or age > STALE_AFTER:
        return {"ok": False, "status": "offline",
                "message": "Mark 1 is offline" + (f" (last seen {fmt_age(age)} ago)" if age is not None else "") + "."}

    # the servo dial sends many moves: only log/notify once per 20 s while dragging
    quiet = actuator == "servo" and action == "angle" and now - int(item.get('note_servo', 0)) < 20
    names, values = {'#c': f"cmd_{actuator}"}, {':c': cmd}
    expr = "SET #c = :c"
    if actuator == "servo" and action == "angle" and not quiet:
        expr += ", note_servo = :ns"
        values[':ns'] = now
    chat_table.update_item(Key=key, UpdateExpression=expr, ExpressionAttributeNames=names, ExpressionAttributeValues=values)

    what = describe_command(actuator, action, cmd)
    if not quiet:
        tail = " using Yageno AI" if via == "ai" else ""
        try:
            stream_put(f"ev#{device_id}", {'kind': 'command', 'actuator': actuator, 'action': action, 'user': user, 'via': via,
                                           'seconds': int(cmd.get('seconds', 0)), 'text': f"@{user} {what}{tail}",
                                           'exp': now + KEEP_SECONDS})
            post_chat('sys', f"@{user} {what}{tail}", level='info', ntype='command')
        except Exception as e:
            print(f"Command log error: {e}")
    return {"ok": True, "id": cmd["id"], "text": what}


@app.post("/api/devices/command")
async def device_command(request: Request):
    user = current_user(request)
    if not user:
        return unauthorized()
    try:
        data = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"status": "bad_json"})
    try:
        r = queue_command(str(data.get("device", "mark1")).strip().lower(), str(data.get("actuator", "")),
                          str(data.get("action", "")), user, data.get("seconds"), data.get("angle"), via="web")
    except Exception as e:
        print(f"Device command error: {e}")
        return JSONResponse(status_code=500, content={"status": "error"})
    if r["ok"]:
        return {"status": "ok", "id": r["id"]}
    return JSONResponse(status_code=409 if r["status"] == "offline" else 400, content={"status": r["status"], "message": r["message"]})


# ===========================================================================
# LIVE SNAPSHOT (goes into the system prompt)
# ===========================================================================
def snapshot_from_reading(r, age, online):
    head = (f"Mark 1 last reported {fmt_age(age)} ago. ONLINE, these are current readings." if online else
            f"Mark 1 last reported {fmt_age(age)} ago. OFFLINE: the values below are the LAST KNOWN values, not current ones.")
    yn = lambda v, a, b: a if v else b
    lines = [
        head,
        f"Flame: {yn(r.get('fire'), 'DETECTED', 'none')}",
        f"Aerial radar: {yn(r.get('aerial'), 'something airborne detected (possibly birds)', 'clear')}",
        f"Sound sensor: {yn(r.get('sound'), 'bird sound detected', 'quiet')}",
        f"Security fence: {yn(r.get('security'), 'BREACH (wire touched)', 'intact')}",
    ]
    if r.get('esp'):
        lines += [f"Temperature: {r.get('temp')} C", f"Humidity: {r.get('hum')} %", f"Soil moisture: {r.get('moist')} %",
                  f"Light: {yn(r.get('day'), 'day', 'night')}", f"Irrigation: {yn(r.get('irrigate'), 'on', 'off')}"]
    else:
        lines.append("ESP32 link is down: temperature, humidity, soil moisture, light and irrigation are unavailable.")
    lines += [f"Sprinkler: {yn(r.get('sprinkler'), 'on', 'off')}",
              f"Servo: {r.get('angle')} degrees, control = {['automatic', 'joystick', 'web'][min(max(r.get('ctl', 0), 0), 2)]}",
              f"Alarm: {yn(r.get('alarm'), 'playing', 'silent')}"]
    return "\n".join(lines)


def latest_snapshot_text(device_id="mark1"):
    try:
        item = chat_table.get_item(Key={'sessionId': device_key(device_id)}).get('Item')
    except Exception as e:
        print(f"Snapshot error: {e}")
        return "Live data: unavailable right now (the device record could not be read)."
    if not item or 'reading' not in item:
        return "Live data: Mark 1 has never sent a reading."
    age = max(0, int(time.time()) - int(item.get('receivedAt', 0)))
    return snapshot_from_reading({k: int(v) for k, v in item['reading'].items()}, age, age <= STALE_AFTER)


# ===========================================================================
# TOOLS the model can call
#   read  : structured RAG over DynamoDB (only the metrics / period asked for)
#   control: switch actuators, or show the same control card as the Devices page
#            (personal chats and the farm chat only, never in a temporary chat)
# ===========================================================================
METRICS = ("temp", "hum", "moist", "day", "irrigate", "sprinkler", "alarm", "angle", "fire", "aerial", "sound", "security")
NUMERIC = {"temp", "hum", "moist", "angle"}
ESP_METRICS = {"temp", "hum", "moist", "day", "irrigate"}       # only valid while the ESP32 link is up
EVENT_TYPES = ["fire", "aerial", "sound", "security", "security_ok", "irrigate", "sprinkler", "alarm", "joystick", "joystick_off",
               "esp", "esp_ok",
               "heat", "heat_ok", "day", "command", "auto", "online", "offline"]

READ_TOOLS = [
    {"name": "get_sensor_history",
     "description": ("Stored readings from Mark 1 over a past period, with a summary (min/max/average/last for numbers; "
                     "times_on and seconds_on for on/off signals) and sampled points. A full reading is stored every 3 hours "
                     "and whenever something changes or an anomaly starts or ends. Ask ONLY for the metrics the question needs. "
                     "Data exists only while Mark 1 was powered."),
     "input_schema": {"type": "object", "properties": {
         "metrics": {"type": "array", "items": {"type": "string", "enum": list(METRICS)},
                     "description": "Only the metrics needed, e.g. [\"fire\"] or [\"moist\",\"irrigate\"]"},
         "hours_back": {"type": "number", "description": "How far back in hours, e.g. 72 for 3 days. Max 168."}},
         "required": ["metrics"]}},
    {"name": "get_events",
     "description": ("Detections (fire, birds/aerial, sound, fence), actuator on/off, user and AI commands, automated decisions, "
                     "online/offline and anomalies, oldest first."),
     "input_schema": {"type": "object", "properties": {
         "hours_back": {"type": "number", "description": "How far back in hours. Max 168."},
         "types": {"type": "array", "items": {"type": "string", "enum": EVENT_TYPES}, "description": "Optional filter"}}}},
]

CONTROL_TOOLS = [
    {"name": "control_actuator",
     "description": ("Switch one Mark 1 actuator RIGHT NOW for the person you are talking to. Only call this when they clearly told you "
                     "to do it and gave everything needed. Irrigation or sprinkler: action 'on' with seconds 5, 60 or 600, or 'off'. "
                     "Alarm: 'on' (plays the Mario theme once) or 'off'. Servo: 'angle' with angle 0-180, or 'release' to give it back "
                     "to automatic. The farm chat announces it automatically."),
     "input_schema": {"type": "object", "properties": {
         "actuator": {"type": "string", "enum": list(ACTUATORS)},
         "action": {"type": "string", "enum": ["on", "off", "angle", "release"]},
         "seconds": {"type": "integer", "enum": sorted(DURATIONS)},
         "angle": {"type": "integer", "minimum": 0, "maximum": 180}},
         "required": ["actuator", "action"]}},
    {"name": "show_controls",
     "description": ("Show the person the same control card(s) as the Devices page under your reply, so they can choose and tap. "
                     "Use when they want to control something but did not say exactly what (for example no duration), ask to see "
                     "the controls, or ask for a time that does not exist."),
     "input_schema": {"type": "object", "properties": {
         "actuators": {"type": "array", "items": {"type": "string", "enum": list(ACTUATORS)}}},
         "required": ["actuators"]}},
]


def _hours(args, default):
    try:
        h = float(args.get("hours_back", default))
    except (TypeError, ValueError):
        h = float(default)
    return max(0.05, min(h, 168.0))


def _usable(row_r, m):
    return m in row_r and not (m in ESP_METRICS and not row_r.get("esp"))


def tool_history(args):
    metrics = [m for m in (args.get("metrics") or []) if m in METRICS] or ["temp", "hum", "moist"]
    hours = _hours(args, 24)
    end = now_ms()
    start = end - int(hours * 3600 * 1000)
    rows = [to_py(i) for i in stream_query("dev#mark1", start, end, limit=8000)]
    if not rows:
        return {"found": False, "message": "No stored data in this period. Mark 1 only records while it is powered (about 5 to 6 pm IST)."}

    summary = {}
    for m in metrics:
        series = [(r["ts"], r["r"][m]) for r in rows if _usable(r["r"], m)]
        if not series:
            summary[m] = {"note": "no data (ESP32 link was down)" if m in ESP_METRICS else "no data"}
            continue
        vals = [v for _, v in series]
        if m in NUMERIC:
            lo, hi = min(series, key=lambda x: x[1]), max(series, key=lambda x: x[1])
            summary[m] = {"min": lo[1], "min_at": fmt_when(lo[0]), "max": hi[1], "max_at": fmt_when(hi[0]),
                          "avg": round(sum(vals) / len(vals), 1), "first": vals[0], "last": vals[-1],
                          "last_at": fmt_when(series[-1][0])}
        else:
            # rows are stored on every change, so a value holds until the next row (capped at one powered hour)
            rises = sum(1 for i, (_, v) in enumerate(series) if v and (i == 0 or not series[i - 1][1]))
            secs = sum(min((series[i + 1][0] - series[i][0]) / 1000, 3600) for i in range(len(series) - 1) if series[i][1])
            on = [t for t, v in series if v]
            summary[m] = {"times_on": rises, "seconds_on": int(secs), "last_on": fmt_when(on[-1]) if on else None}

    n = len(rows)
    step = max(1, -(-n // 40))
    points = []
    for i in range(0, n, step):
        chunk = rows[i:i + step]
        pt = {"t": fmt_when(chunk[0]["ts"])}
        for m in metrics:
            vs = [c["r"][m] for c in chunk if _usable(c["r"], m)]
            if vs:
                pt[m] = round(sum(vs) / len(vs), 1) if m in NUMERIC else max(vs)
        points.append(pt)
    return {"found": True, "timezone": "IST (UTC+5:30)", "from": fmt_when(start), "to": fmt_when(end), "stored_rows": n,
            "summary": summary, "points": points}


def tool_events(args):
    hours = _hours(args, 24)
    types = set(args.get("types") or [])
    end = now_ms()
    start = end - int(hours * 3600 * 1000)
    out, counts = [], {}
    for r in (to_py(i) for i in stream_query("ev#mark1", start, end, limit=2000)):
        typ = r.get("type") if r.get("kind") == "event" else "command"
        if types and typ not in types:
            continue
        counts[typ] = counts.get(typ, 0) + 1
        out.append({"t": fmt_when(r["ts"]), "type": typ, "text": r.get("text", "")})
    return {"timezone": "IST (UTC+5:30)", "count": len(out), "by_type": counts, "events": out[-40:]}


def tool_control(args, ctx):
    if not ctx.get("control"):
        return {"ok": False, "message": "Controls are not available in this chat."}
    act, action = args.get("actuator"), args.get("action")
    r = queue_command("mark1", act, action, ctx["user"], args.get("seconds"), args.get("angle"), via="ai")
    ctx["actions"].append({"actuator": act, "action": action, "ok": r["ok"],
                           "text": r.get("text") or r.get("message", "")})
    if r["ok"]:
        return {"ok": True, "done": r["text"], "note": "Queued. Mark 1 runs it within about a second."}
    return {"ok": False, "reason": r["message"]}


def tool_show(args, ctx):
    if not ctx.get("control"):
        return {"ok": False, "message": "Controls are not available in this chat."}
    acts = [a for a in (args.get("actuators") or []) if a in ACTUATORS]
    for a in acts:
        if a not in ctx["cards"]:
            ctx["cards"].append(a)
    return {"ok": bool(acts), "shown": acts, "note": "The cards appear under your reply. Tell the person to tap one to choose."}


def run_tool(name, args, ctx):
    try:
        if name == "get_sensor_history":
            return tool_history(args)
        if name == "get_events":
            return tool_events(args)
        if name == "control_actuator":
            return tool_control(args, ctx)
        if name == "show_controls":
            return tool_show(args, ctx)
        return {"error": "unknown tool"}
    except Exception as e:
        print(f"Tool error {name}: {e}")
        return {"error": "the tool failed right now"}


def new_ctx(user, control):
    return {"user": user, "control": bool(control), "cards": [], "actions": []}


# ===========================================================================
# MODEL CALL (extended thinking + tool loop)
# ===========================================================================
THINKING_BUDGET = max(1024, int(os.environ.get("THINKING_BUDGET", "2500")))


def _invoke(payload):
    resp = bedrock.invoke_model(modelId=MODEL_ID, contentType="application/json", accept="application/json",
                                body=json.dumps(payload))
    return json.loads(resp.get("body").read())


def call_bedrock(messages, mode, system_text, ctx):
    payload = {"anthropic_version": "bedrock-2023-05-31", "max_tokens": 1000, "system": system_text,
               "tools": READ_TOOLS + (CONTROL_TOOLS if ctx.get("control") else [])}
    if mode == "thinking":
        payload["max_tokens"] = THINKING_BUDGET + 2000
        payload["thinking"] = {"type": "enabled", "budget_tokens": THINKING_BUDGET}

    msgs, body = list(messages), {}
    for _ in range(5):                                   # at most 4 tool rounds, then a final answer
        payload["messages"] = msgs
        try:
            body = _invoke(payload)
        except botocore.exceptions.ClientError as e:
            if "thinking" in payload and error_code(e) == "ValidationException":
                payload.pop("thinking")
                payload["max_tokens"] = 1500
                payload["system"] += ("\n\nWrite your private reasoning first inside <thinking>...</thinking> tags, "
                                      "then give your reply after the closing tag.")
                body = _invoke(payload)
            else:
                raise
        if body.get("stop_reason") != "tool_use":
            break
        content = body.get("content", [])
        msgs.append({"role": "assistant", "content": content})       # keeps thinking blocks intact
        results = [{"type": "tool_result", "tool_use_id": b["id"],
                    "content": json.dumps(run_tool(b["name"], b.get("input") or {}, ctx), default=str)[:12000]}
                   for b in content if b.get("type") == "tool_use"]
        msgs.append({"role": "user", "content": results})
    return body


def split_response(body):
    thoughts, texts = [], []
    for block in body.get("content", []):
        kind = block.get("type")
        if kind == "thinking":
            thoughts.append(block.get("thinking", ""))
        elif kind == "text":
            texts.append(block.get("text", ""))
    answer = "\n\n".join(t.strip() for t in texts if t.strip()).strip()
    reasoning = "\n\n".join(t for t in thoughts if t).strip()
    m = re.search(r"<thinking>(.*?)</thinking>", answer, re.DOTALL)
    if m:
        reasoning = (reasoning + "\n\n" + m.group(1).strip()).strip()
        answer = answer.replace(m.group(0), "").strip()
    return answer, reasoning


def fallback_text(ctx):
    done = [a["text"] for a in ctx["actions"] if a["ok"]]
    if done:
        return "Done: " + "; ".join(done) + "."
    if ctx["cards"]:
        return "Here are the controls. Tap one to choose."
    return ""


# ===========================================================================
# PERSONAL CHAT ENDPOINT
# ===========================================================================
@app.post("/api/chat")
async def chat_endpoint(request: Request):
    user = current_user(request)
    if not user:
        return unauthorized()
    project = current_project(request)

    data = await request.json()
    user_prompt = data.get("prompt", "")
    mode = data.get("mode", "flash")
    temp = bool(data.get("temp", False))
    session_id = data.get("sessionId")
    edit_from_index = data.get("editFromIndex")
    temp_history = data.get("history") or []

    messages, title, pinned, keep, is_new = [], None, 'false', {}, False

    if temp:
        messages = [{"role": m.get("role"), "content": m.get("content", "")} for m in temp_history
                    if m.get("role") in ("user", "assistant")]
    else:
        if not session_id:
            session_id = str(uuid.uuid4())
            is_new = True
        else:
            try:
                item = chat_table.get_item(Key={'sessionId': session_id}).get('Item')
                if item:
                    if item.get('username') != user:
                        return JSONResponse(status_code=403, content={"text": "This chat belongs to another user."})
                    messages = item.get('messages', [])
                    title = item.get('title')
                    pinned = item.get('pinned', 'false')
                    keep = {k: item[k] for k in ('shared', 'sharedFrom') if k in item}
                else:
                    is_new = True
            except Exception as e:
                print(f"DynamoDB Load Error: {e}")
        if isinstance(edit_from_index, int):
            messages = messages[:edit_from_index]

    messages.append({"role": "user", "content": user_prompt})
    claude_messages = [{"role": m["role"], "content": [{"type": "text", "text": m["content"] or "(empty)"}]} for m in messages]

    ctx = new_ctx(user, control=not temp)
    try:
        system_text = build_system_prompt(latest_snapshot_text(), deep=(mode == "thinking"), channel="personal",
                                          control=not temp)
        body = call_bedrock(claude_messages, mode, system_text, ctx)
        output_text, reasoning = split_response(body)
        output_text = output_text or fallback_text(ctx)
        if not output_text:
            return JSONResponse(status_code=502, content={"text": "The model returned no answer."})

        if not temp:
            reply = {"role": "assistant", "content": output_text}
            if ctx["cards"]:
                reply["cards"] = ctx["cards"]
            if ctx["actions"]:
                reply["actions"] = ctx["actions"]
            messages.append(reply)
            if is_new or not title:
                words = user_prompt.split()
                title = " ".join(words[:4]) + ("..." if len(words) > 4 else "")
            try:
                chat_table.put_item(Item={**keep, 'sessionId': session_id, 'username': user, 'project': project,
                                          'title': title, 'updatedAt': now_iso(), 'messages': messages, 'pinned': pinned})
            except Exception as e:
                print(f"DynamoDB Save Error: {e}")

        return {"text": output_text, "reasoning": reasoning, "sessionId": session_id, "title": title if is_new else None,
                "cards": ctx["cards"], "actions": ctx["actions"]}
    except botocore.exceptions.ClientError as error:
        print(f"Bedrock API Error: {error}")
        if error_code(error) == 'ThrottlingException':
            return JSONResponse(status_code=429, content={"text": "High traffic. Try again."})
        return JSONResponse(status_code=500, content={"text": "API Error."})


# ===========================================================================
# SHARED FARM CHAT  (everyone on the Farm project, one AI, polled by the browsers)
# ===========================================================================
LOCK_MS = 50_000


def public_item(it):
    it = to_py(it)
    keys = ("ts", "kind", "user", "text", "ai", "status", "replyTo", "decision", "reason", "hazards", "source", "mode",
            "level", "ntype", "cards", "actions")
    return {k: it[k] for k in keys if k in it}


def _lock_until():
    row = stream_table.get_item(Key={'pk': LOCK, 'ts': 0}).get('Item')
    return int(row.get('lu', 0)) if row else 0


def acquire_lock():
    now = now_ms()
    try:
        stream_table.update_item(Key={'pk': LOCK, 'ts': 0}, UpdateExpression="SET lu = :n",
                                 ConditionExpression="attribute_not_exists(lu) OR lu < :now",
                                 ExpressionAttributeValues={':n': now + LOCK_MS, ':now': now})
        return True
    except botocore.exceptions.ClientError as e:
        if error_code(e) == CONDITIONAL_FAIL:
            return False
        raise


def set_lock(until):
    stream_table.update_item(Key={'pk': LOCK, 'ts': 0}, UpdateExpression="SET lu = :n", ExpressionAttributeValues={':n': until})


def oldest_pending():
    now = now_ms()
    rows = [to_py(r) for r in stream_query(CHAT, 0, now + 1000, desc=True, limit=80)]
    cand = [r for r in rows if r.get("kind") == "user" and r.get("ai") is True and
            (r.get("status") == "pending" or (r.get("status") == "processing" and now - int(r.get("startedAt", 0)) > 60_000))]
    return min(cand, key=lambda r: r["ts"]) if cand else None


def claim(ts):
    now = now_ms()
    try:
        stream_table.update_item(Key={'pk': CHAT, 'ts': ts}, UpdateExpression="SET #s = :proc, startedAt = :n",
                                 ConditionExpression="#s = :pend OR (#s = :proc AND startedAt < :stale)",
                                 ExpressionAttributeNames={'#s': 'status'},
                                 ExpressionAttributeValues={':proc': 'processing', ':pend': 'pending', ':n': now, ':stale': now - 60_000})
        return True
    except botocore.exceptions.ClientError as e:
        if error_code(e) in (CONDITIONAL_FAIL, "ValidationException"):
            return False
        raise


def finish(ts):
    try:
        stream_table.update_item(Key={'pk': CHAT, 'ts': ts}, UpdateExpression="SET #s = :d",
                                 ConditionExpression="attribute_exists(#t)",
                                 ExpressionAttributeNames={'#s': 'status', '#t': 'ts'}, ExpressionAttributeValues={':d': 'done'})
    except botocore.exceptions.ClientError:
        pass


def build_global_context(msg):
    rows = [to_py(r) for r in stream_query(CHAT, 0, int(msg["ts"]) - 1, desc=True, limit=40)]
    rows.reverse()
    turns = []

    def add(role, text):
        if turns and turns[-1][0] == role:
            turns[-1] = (role, turns[-1][1] + "\n" + text)
        else:
            turns.append((role, text))

    for r in rows:
        k = r.get("kind")
        if k == "user" and r.get("ai") is True and r.get("status") == "done":      # team-only messages are skipped
            add("user", f"@{r['user']}: {r['text']}")
        elif k == "ai":
            add("assistant", r["text"])
        elif k in ("sys", "auto"):
            add("user", f"[notice] {r['text']}" + (f" Reason: {r['reason']}" if r.get("reason") else ""))
    while turns and turns[0][0] != "user":
        turns.pop(0)
    add("user", f"@{msg['user']}: {msg['text']}")
    return [{"role": r, "content": [{"type": "text", "text": t}]} for r, t in turns]


def process_pending(budget=10):
    """Answer pending messages one at a time. Only one request holds the lock, so there is only ever one AI."""
    if not acquire_lock():
        return {"status": "busy"}
    t0, handled = time.time(), 0
    try:
        while time.time() - t0 < budget:
            msg = oldest_pending()
            if not msg:
                break
            ts = int(msg["ts"])
            if not claim(ts):
                continue                                           # retracted or taken
            mode = "thinking" if msg.get("mode") == "thinking" else "flash"
            ctx = new_ctx(msg["user"], control=True)
            try:
                system_text = build_system_prompt(latest_snapshot_text(), deep=(mode == "thinking"), channel="global",
                                                  control=True)
                text, _ = split_response(call_bedrock(build_global_context(msg), mode, system_text, ctx))
                text = text or fallback_text(ctx)
                if not text:
                    raise RuntimeError("empty answer")
                post_chat('ai', text, replyTo=ts, cards=ctx["cards"] or None, actions=ctx["actions"] or None)
            except Exception as e:
                print(f"Global AI error: {e}")
                post_chat('sys', f"Yageno AI could not answer @{msg['user']}. Please send it again.", user='Yageno AI',
                          level='info', ntype='error')
            finish(ts)
            handled += 1
            set_lock(now_ms() + LOCK_MS)
    finally:
        set_lock(0)
    return {"status": "ok", "handled": handled}


@app.get("/api/global")
async def global_feed(request: Request):
    user = current_user(request)
    if not user:
        return unauthorized()
    try:
        now = now_ms()
        try:
            check_offline(chat_table.get_item(Key={'sessionId': device_key("mark1")}).get('Item'), now // 1000)
        except Exception as e:
            print(f"Offline check error: {e}")
        rows = stream_query(CHAT, 0, now + 1000, desc=True, limit=60)
        rows.reverse()
        return {"items": [public_item(r) for r in rows], "aiBusy": _lock_until() > now, "now": now, "me": user}
    except Exception as e:
        print(f"Global feed error: {e}")
        return JSONResponse(status_code=500, content={"status": "error"})


@app.post("/api/global/send")
async def global_send(request: Request):
    user = current_user(request)
    if not user:
        return unauthorized()
    data = await request.json()
    text = str(data.get("text", "")).strip()[:2000]
    if not text:
        return JSONResponse(status_code=400, content={"status": "empty"})
    ai = bool(data.get("ai", True))
    mode = "thinking" if data.get("mode") == "thinking" else "flash"
    try:
        ts = stream_put(CHAT, {'kind': 'user', 'user': user, 'text': text, 'ai': ai, 'mode': mode,
                               'status': 'pending' if ai else 'done', 'exp': int(time.time()) + KEEP_SECONDS})
        return {"ts": ts}
    except Exception as e:
        print(f"Global send error: {e}")
        return JSONResponse(status_code=500, content={"status": "error"})


@app.post("/api/global/process")
async def global_process(request: Request):
    if not current_user(request):
        return unauthorized()
    try:
        return process_pending()
    except Exception as e:
        print(f"Global process error: {e}")
        try:
            set_lock(0)
        except Exception:
            pass
        return JSONResponse(status_code=500, content={"status": "error"})


@app.delete("/api/global/messages/{ts}")
async def global_retract(ts: int, request: Request):
    """Retract your own message while it is still pending."""
    user = current_user(request)
    if not user:
        return unauthorized()
    try:
        stream_table.delete_item(Key={'pk': CHAT, 'ts': ts},
                                 ConditionExpression="#k = :k AND #u = :u AND #s = :p",
                                 ExpressionAttributeNames={'#k': 'kind', '#u': 'user', '#s': 'status'},
                                 ExpressionAttributeValues={':k': 'user', ':u': user, ':p': 'pending'})
        return {"status": "retracted"}
    except botocore.exceptions.ClientError as e:
        if error_code(e) == CONDITIONAL_FAIL:
            return JSONResponse(status_code=409, content={"status": "too_late"})
        print(f"Retract error: {e}")
        return JSONResponse(status_code=500, content={"status": "error"})


# ===========================================================================
# AUTOMATED DECISION
#   Mark 1 watches a 5-second window. When flame, aerial radar or bird sound shows up it collects whatever else
#   appears in those 5 seconds and sends it here. The sprinkler ALWAYS runs; Yageno AI picks how long, whether the
#   alarm joins, and writes the reason. The decision card goes to the farm chat.
# ===========================================================================
DECIDE_RULES = """AUTOMATED DECISION MODE
A 5-second hazard window just closed on Mark 1. The sprinkler WILL run now (the servo sweeps the spray and a siren sounds).
Decide:
- sprinkler_seconds: 5 or 60.
  Birds: aerial radar AND bird sound together -> 60 (birds are almost certainly there). Only one of them -> 5 (a short scare).
  Flame (with or without anything else) -> 60.
- alarm: true for flame, otherwise false.
- reason: one or two plain sentences for the farm team saying what the sensors indicate and why this action. Examples of the tone:
  "Acoustic noise and the aerial radar both indicate a flock of birds over the field, so the sprinkler sweeps for 1 minute to scare them off before they reach the crop."
  "A flame was detected, so a fire may have broken out. The sprinkler runs for 1 minute to keep it from spreading and the alarm warns everyone nearby."
Reply with ONLY JSON, nothing else: {"sprinkler_seconds": 60, "alarm": false, "reason": "..."}"""

HAZARD_NAMES = {"fire": "flame detected", "aerial": "aerial radar saw something airborne (possibly birds)", "sound": "bird sound (acoustic) heard"}


def rule_decision(hazards):
    if "fire" in hazards:
        return {"sprinkler_seconds": 60, "alarm": True,
                "reason": "A flame was detected, so a fire may have broken out. The sprinkler runs for 1 minute to keep it from spreading and the alarm warns everyone nearby."}
    if "aerial" in hazards and "sound" in hazards:
        return {"sprinkler_seconds": 60, "alarm": False,
                "reason": "Acoustic noise and the aerial radar both indicate birds over the field, so the sprinkler sweeps for 1 minute to scare them off."}
    what = "The aerial radar saw something airborne" if "aerial" in hazards else "Bird sound was heard"
    return {"sprinkler_seconds": 5, "alarm": False,
            "reason": f"{what}, possibly birds, so a short 5 second sprinkler burst scares them off."}


def ai_decision(hazards, reading):
    snapshot = snapshot_from_reading(reading, 0, True)
    names = ", ".join(HAZARD_NAMES[h] for h in hazards)
    system_text = build_system_prompt(snapshot, deep=False, channel="decide", control=False) + "\n\n" + DECIDE_RULES
    body = _invoke({"anthropic_version": "bedrock-2023-05-31", "max_tokens": 300, "system": system_text,
                    "messages": [{"role": "user", "content": [{"type": "text", "text": f"Window closed. Detected: {names}."}]}]})
    text = split_response(body)[0]
    m = re.search(r"\{.*\}", text, re.S)
    d = json.loads(m.group(0))
    sec = 60 if int(d.get("sprinkler_seconds", 5)) > 5 else 5          # always runs: only 5 or 60 reach the hardware
    alarm = bool(d.get("alarm", False))
    if "fire" in hazards:
        sec, alarm = 60, True                                          # safety floor for flame, whatever the model said
    return {"sprinkler_seconds": sec, "alarm": alarm,
            "reason": str(d.get("reason", "")).strip()[:400] or rule_decision(hazards)["reason"]}


@app.post("/api/device/decide")
async def device_decide(request: Request):
    sent = request.headers.get("x-device-key", "")
    if not DEVICE_KEY or not hmac.compare_digest(sent.encode(), DEVICE_KEY.encode()):
        return JSONResponse(status_code=401, content={"status": "unauthorized"})
    try:
        data = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"status": "bad_json"})

    device_id = str(data.get("deviceId", "mark1")).strip().lower()
    hazards = sorted({h for h in (data.get("hazards") or []) if h in HAZARD_NAMES})
    if device_id not in DEVICE_IDS or not hazards or not isinstance(data.get("state"), dict):
        return JSONResponse(status_code=400, content={"status": "invalid"})

    now = int(time.time())
    key = {'sessionId': device_key(device_id)}
    lane = "lastAutoFire" if "fire" in hazards else "lastAuto"      # flame has its own cooldown: birds never block it
    try:
        # claim the cooldown first so two windows never produce two decisions
        try:
            chat_table.update_item(Key=key, UpdateExpression=f"SET {lane} = :n",
                                   ConditionExpression=f"attribute_not_exists({lane}) OR {lane} < :c",
                                   ExpressionAttributeValues={':n': now, ':c': now - AUTO_COOLDOWN})
        except botocore.exceptions.ClientError as e:
            if error_code(e) == CONDITIONAL_FAIL:
                item = chat_table.get_item(Key=key, ConsistentRead=True).get('Item') or {}
                return {"status": "cooldown", "commands": pending_commands(item, now)}
            raise

        reading = clean_reading(data["state"])
        try:
            decision, source = ai_decision(hazards, reading), "ai"
        except Exception as e:
            print(f"AI decision failed, using rules: {e}")
            decision, source = rule_decision(hazards), "rules"

        sec, alarm = decision["sprinkler_seconds"], decision["alarm"]
        now = int(time.time())
        names = {'#s': 'cmd_sprinkler'}
        values = {':s': {"id": uuid.uuid4().hex[:12], "action": "on", "seconds": sec, "by": "yageno", "via": "auto", "at": now}}
        sets = ["#s = :s"]
        if alarm:
            names['#a'] = 'cmd_alarm'
            values[':a'] = {"id": uuid.uuid4().hex[:12], "action": "on", "by": "yageno", "via": "auto", "at": now}
            sets.append("#a = :a")
        new_item = chat_table.update_item(Key=key, UpdateExpression="SET " + ", ".join(sets), ExpressionAttributeNames=names,
                                          ExpressionAttributeValues=values, ReturnValues="ALL_NEW").get("Attributes", {})

        what = f"Sprinkler on for {fmt_secs(sec)}" + (" and alarm on" if alarm else "")
        try:
            post_chat('auto', f"Automated decision: {what}", user='Yageno AI', decision=what, reason=decision["reason"],
                      hazards=hazards, source=source)
            stream_put(f"ev#{device_id}", {'kind': 'event', 'type': 'auto', 'text': f"Automated decision: {what}. {decision['reason']}",
                                           'exp': now + KEEP_SECONDS})
        except Exception as e:
            print(f"Auto decision log error: {e}")
        return {"status": "ok", "decision": what, "source": source, "commands": pending_commands(new_item, now)}
    except Exception as e:
        print(f"Device decide error: {e}")
        return JSONResponse(status_code=500, content={"status": "error"})


# ---------------------------------------------------------------------------
# API Gateway puts a prefix in front of every path (e.g. /default/First_Fastapi_webapp/api/chat).
# This wrapper removes everything before the first "/api" or "/static" segment.
# ---------------------------------------------------------------------------
_PREFIX = re.compile(r'^(.*?)/(?:api|static)(?=/|$)')


class StripPrefix:
    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            path = scope["path"]
            m = _PREFIX.match(path)
            base = m.group(1) if m else path.rstrip("/")
            if base and path.startswith(base):
                scope = dict(scope)
                scope["path"] = path[len(base):] or "/"
                scope["raw_path"] = scope["path"].encode()
        await self.inner(scope, receive, send)


asgi_app = StripPrefix(app)
handler = Mangum(asgi_app, lifespan="off")

if __name__ == "__main__":
    uvicorn.run(asgi_app, host="0.0.0.0", port=8080)