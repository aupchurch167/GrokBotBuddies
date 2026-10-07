import type { AdminSession, Bot } from "./generated/prisma/client.js";

export type AppEnv = {
  Variables: {
    requestId: string;
    bot: Bot;
    adminSession: AdminSession;
    logBotId: string;
  };
};
