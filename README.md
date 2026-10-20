# TDengine All-in-One Smoketest

Branded Electron app. Every launch and every **Run smoke tests** click refetches `https://downloads.tdengine.com/apex/versions.json` and the current component manifests. It never uses a cached package list.

## Run

Double-click **TDengine All-in-One Smoketest** on the Desktop, or:

```bash
cd ~/Desktop/TDengine-AIO-Smoketest
npm install
npm start          # dev
npm run pack       # build the macOS .app
```

Checks Linux host, Windows host, and Docker All-in-One artifacts that the live catalog points at. It does not install the stack.
