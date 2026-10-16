/// <reference types="@solidjs/start/env" />
import type { Identity } from "./server/access";

declare global {
  namespace App {
    interface RequestEventLocals {
      identity?: Identity;
    }
  }
}

export {};
