# Yageno AI

**A plug-in AI layer for any IoT project, built on AWS.**
AWS Bharat Builds Tour, Track 02: Heat and Water.

Yageno AI is software that sits on top of internet-connected sensors and actuators. A device sends its readings to one API and gets commands back. Claude on Amazon Bedrock then explains the data in plain language, answers questions about the past, and switches devices on or off, either when a person asks or automatically when a hazard appears. Nobody has to build a new dashboard for each project.

## The Problem

Heatwaves dry the soil. Droughts, leaks and badly timed irrigation waste water. Floods and water tankers need someone watching. Many people already own cheap internet-connected sensors, but the readings end up in a serial monitor or a one-off dashboard. Turning readings into decisions ("is this a leak or normal use?", "should the pump run now?") needs custom software and someone watching, which small farms, colleges, housing societies and local water teams rarely have.

## What It Does

- **Plug in, plug out:** any device with an internet connection sends readings to one API and receives commands back.
- **Explains the data:** Claude turns live readings into plain-language answers, with what is normal, what is risky and what to do next.
- **Remembers the past:** ask "when did the soil last dry out this week?" and Claude queries the stored history instead of guessing.
- **Acts on devices:** it switches irrigation, a sprinkler or an alarm when a person asks, or automatically when a hazard appears, and always says why.
- **Works as a team:** a shared project chat shows alerts, who did what, and the AI's automated decisions.

## The Web App

Everything below runs in the browser on phone or laptop. There is nothing to install.

### Sign-in and projects

- Pick a username and choose a project (Farm today; Forest fire, Water network, Air quality, Traffic signals and Add project are shown as "Soon"). There is no password in this demo.
- A short first-time step lets you choose one of 12 colour themes. Your theme and chats follow your username.

### Chat with the AI

- **Saved conversations:** every chat is stored in Amazon DynamoDB, with pin, rename, delete and search in the sidebar.
- **Flash and Thinking modes:** Flash answers fast. Thinking turns on extended reasoning, and the chain of thought can be opened and read in a collapsible panel.
- **Edit and retry:** edit an earlier message and the chat continues from there, or retry a reply that failed.
- **Temporary chat:** a chat that is never saved. It also cannot control devices.
- **Branch a chat:** copy a conversation into a new chat to explore a different direction.
- **Share a chat:** create a share link. Whoever opens it gets their own copy, titled "Shared", and the original is left untouched.
- **Readable answers:** markdown rendering, a smooth word-by-word reveal, and keyboard shortcuts with hover hints.
- **Built for phones:** a sliding sidebar, swipe gestures and a composer that behaves on mobile keyboards.

### Data and device tools inside the chat

- Claude can read the database with `get_sensor_history` and `get_events`, asking only for the metrics and time range it needs.
- If you say "turn on the irrigation for 1 minute", Claude does it in the background with `control_actuator`. If you only say "I want to water the plants", it shows a control card with `show_controls` so you can pick the time.

### Devices page

- Live cards for every sensor and actuator, with an online or offline status and the time since the last reading.
- Timed irrigation and sprinkler runs (5 seconds, 1 minute or 10 minutes), a 180 degree servo dial, and an alarm.
- An offline popup, and an "Add device" popup that explains how new devices will connect.

### Shared project chat

- One room per project that the whole team sees: messages, alerts, actions and automated decisions.
- Mention teammates with `@username`. The AI replies when asked, and only one AI reply runs at a time (a DynamoDB conditional lock).
- Send a message and retract it while it is still pending. A team-only toggle keeps the AI out of a message.
- Alerts (fire, fence breach, offline) look different from info notices (irrigation on, a command by a teammate).
- Automated decisions appear as a card with the decision and its reason.

## The Working Demo

The Farm project is the working demo for Heat and Water. It watches soil moisture, temperature and humidity, flags heat stress (above 32 C) and dry soil (30% or below), and runs timed irrigation. When several hazard signals appear together (flame, a flying object, bird sound), the device waits 5 seconds, then asks the AI. Claude returns a sprinkler duration, whether to sound the alarm, and a reason, the sprinkler runs, and the decision is posted in the project chat. A rule-based fallback runs if Bedrock fails.

## The Vision

Farm is only the first project. Water network (tanks, pipes and leaks) is next because it sits at the heart of Heat and Water. Forest fire, Air quality and Traffic signals follow, and Add project will let anyone connect a new set of sensors and actuators. The same pipeline can take a water-level, flow or tank sensor, which covers floods, waterlogging, leaks, tankers and groundwater.

## Who It Is For

Farmers, colleges, housing societies, water boards and anyone with an IoT project and an internet connection. They get plain-language answers and one-tap controls, and no coding is needed to use it.

## Architecture

```
Device (any internet-connected board)
   |  HTTPS: readings in, pending commands back
   v
Amazon API Gateway  ->  AWS Lambda (FastAPI + Mangum)  ->  Amazon DynamoDB
                                   |
                                   v
                          Amazon Bedrock (Claude Haiku 4.5)

Browser (chat, Devices page, project chat)  ->  same API Gateway
```

### AWS services

- **Amazon Bedrock:** Claude Haiku 4.5 (`au.anthropic.claude-haiku-4-5-20251001-v1:0`, cross-region inference profile in `ap-southeast-2`) for chat, extended thinking, tool use and automated decisions.
- **AWS Lambda:** the FastAPI backend (Python 3.12, Linux x86_64).
- **Amazon API Gateway:** the public HTTPS endpoint for the web app and for devices.
- **Amazon DynamoDB:** two tables, described below.
- **Amazon S3:** holds the deployment zip that Lambda is updated from.
- **AWS IAM and Amazon CloudWatch:** permissions and logs.

### Data model

| Table | Key | Holds |
| --- | --- | --- |
| `YagenoChats` | `sessionId` (String) | Chats, users (`USER#name`), latest device reading and pending commands (`DEVICE#mark1`) |
| `YagenoStream` | `pk` (String), `ts` (Number, ms) | Stored readings (`dev#<id>`), events (`ev#<id>`), shared chat (`chat#<project>`), AI lock (`lock#<project>`). TTL attribute: `exp` |

To keep storage small, a full reading is stored every 3 hours, plus whenever something changes and whenever an anomaly starts or ends. DynamoDB TTL removes old data.

### Main endpoints

| Area | Endpoints |
| --- | --- |
| Users | `/api/users/check`, `/api/users/claim`, `/api/users/login`, `/api/users/theme` |
| Chats | `/api/chats`, `/api/chats/{id}` (get, rename or pin, delete), `/api/chats/{id}/branch`, `/api/chats/{id}/share`, `/api/share/{id}/import`, `/api/chat` |
| Devices | `/api/devices`, `/api/devices/command`, `/api/device/ingest`, `/api/device/decide` |
| Project chat | `/api/global`, `/api/global/send`, `/api/global/process`, `/api/global/messages/{ts}` |

## Device API

A device only needs HTTPS.

- `POST /api/device/ingest` with the header `X-Device-Key`: send the current readings. The reply carries any pending commands.
- Commands expire after 15 seconds and each command runs only once.
- A device that is silent for 20 seconds is shown as offline.
- `POST /api/device/decide` (same key): ask for an automated hazard decision.

## Built During the Hackathon

The whole software platform was built during the event: the web app, the AI features, the backend, the AWS infrastructure and the device API. The demo device is the exception. It is a small Arduino Uno Q plus ESP32 node that I built a month before the hackathon, and it is only a stand-in so the software can be shown with real sensors. It is powered from a laptop, so it is online about 5 to 6 PM IST, and outside that hour the app shows the last known data. ## Repository Structure

```
├── app.py                 FastAPI app and Lambda handler (Mangum)
├── system_prompt.py       Yageno AI system prompt
├── requirements.txt       Python dependencies
├── LICENSE                GNU AGPL-3.0
├── templates/
│   └── index.html         App shell
├── static/
│   ├── app.js             Personal chat
│   ├── globalchat.js      Shared project chat
│   ├── devices.js         Devices page and control cards
│   ├── gate.js            Username and project picker
│   ├── style.css, gc.css, devices.css, gate.css
```

## Run Locally

You need AWS credentials with access to Bedrock and DynamoDB, plus the two tables above.

```bash
pip install -r requirements.txt
export DEVICE_KEY="choose-a-long-random-key"
python app.py
```

Open `http://localhost:8080`. Optional environment variables: `STREAM_TABLE` (default `YagenoStream`), `LOCAL_TZ_OFFSET_MIN` (default `330`), `THINKING_BUDGET` (default `2500`).

## Deploy to AWS

1. Build a Linux package. Lambda runs Linux, so download Linux wheels even on a Mac:

   ```bash
   pip install -t package -r requirements.txt --platform manylinux2014_x86_64 --only-binary=:all:
   cp -r app.py system_prompt.py templates static package/
   cd package && zip -r ../deployment_linux.zip . -x "*.DS_Store" && cd ..
   ```

2. Upload the zip to S3 and update the function:

   ```bash
   aws s3 cp deployment_linux.zip s3://<your-bucket>/deployment_linux.zip
   aws lambda update-function-code \
     --function-name <your-function> \
     --s3-bucket <your-bucket> \
     --s3-key deployment_linux.zip \
     --region ap-southeast-2
   ```

3. Lambda settings: Python 3.12, x86_64, timeout of at least 30 seconds (API Gateway cuts requests at 29 seconds), 256 MB memory, and the environment variable `DEVICE_KEY`.
4. IAM: allow the Lambda role `bedrock:InvokeModel` and DynamoDB `GetItem`, `PutItem`, `UpdateItem`, `DeleteItem` and `Query` on both tables.
5. API Gateway: use a greedy route such as `ANY /<function>/{proxy+}`. The app strips the stage and function prefix itself.

## Limits

- Farm is the only working project. The others are planned, and the Add project flow is not built yet.
- The demo device is online only about an hour a day.
- The flying-object sensor means "birds or something airborne", not object recognition.
- Login is a username only, which is fine for a demo and not for production.
- Replies arrive as a whole and the UI reveals them word by word. Token streaming is not implemented.
- Do not commit your `DEVICE_KEY`. Keep it in an environment variable.

## Roadmap

1. Water network: tank levels, pipe pressure and leak detection.
2. The Add project flow, so anyone can connect new sensors and actuators without editing code.
3. Forest fire, Air quality and Traffic signals.
4. Real authentication.

## Credits

Yageno AI is built on open-source software. Each project keeps its own licence.

- Backend: FastAPI (MIT), Starlette (BSD-3-Clause), Uvicorn (BSD-3-Clause), Mangum (MIT), Jinja2 (BSD-3-Clause), boto3 (Apache-2.0).
- Frontend: marked.js (MIT).
- Demo device: Arduino core and the Servo library (LGPL-2.1), U8g2 (BSD-2-Clause), Adafruit DHT library (MIT), ESP32 Arduino core (LGPL-2.1).
- Font: Libron font under SIL Open Font License (OFL)

## Author

Athokpam Yaraba Luwang (Yaraba).

## License

Copyright (C) 2026 Athokpam Yaraba Luwang.

Licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0). If you modify Yageno AI and let other people use it over a network, you must offer them the complete source of your modified version under the same licence. Using it unmodified, for example for your own farm, has no such requirement.

A separate commercial licence is available for organisations that want to use it in a closed-source product. Contact the author.
