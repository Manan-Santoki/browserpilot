# BrowserPilot for Android and iOS

The phone half of BrowserPilot. It exists for one thing above all others: the
robot stops and asks before anything destructive, and this is how you answer
that from wherever you are.

## What it does

Four tabs, in the order you reach for them.

- **Sessions** — what the robot is doing. Anything waiting on you comes first,
  then whatever is running, then history. Tapping one opens the live browser,
  the conversation, and the approval if there is one.
- **Files** — everything the robot has downloaded, under the session that
  fetched it. Opening one hands it to the phone's own viewer.
- **Sites** — where the robot can be sent, and starting it off. A site you have
  not signed in to says so rather than offering a button that leads nowhere:
  signing in has to happen at a real keyboard.
- **Account** — who this phone is signed in as, and unpairing.

## Pairing

The app holds no password. Open the console on a computer, go to **Devices**,
and show the pairing code; scanning it links the phone to your account. The code
is single-use and expires in minutes.

If the camera is refused, the same code can be typed.

## How it authenticates

Two credentials, deliberately.

The **device token** comes from pairing, lives in the platform keystore, and is
sent to exactly one endpoint: `/api/device/session`. That trades it for a
**session token** — the same kind the console keeps in a cookie — which is what
every other request carries and which expires on its own.

So a phone left in a taxi stops working without anyone doing anything, and
revoking the device in the console stops it sooner. Every route written for the
console serves the app too, because the only difference is whether the session
travels in a cookie or a header.

## Running it

```bash
bun install
bun run start          # Expo dev server; scan with Expo Go
bun run android        # build and install on a connected device
bun run typecheck
```

`scripts/device-test.sh` walks the tabs on a connected device and captures a
screenshot of each, failing if anything logs a fatal error.

## Pointing at a different console

The app talks to `https://browserpilot.msantoki.com` unless told otherwise.
There is a **Connecting to a different console?** field on the pairing screen
for a local or self-hosted one.
