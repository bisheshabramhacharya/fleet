import { contextBridge } from "electron";

// The dashboard talks to the local fleet server over HTTP; this only tells it it runs in the app.
contextBridge.exposeInMainWorld("fleetDesktop", { platform: process.platform });
