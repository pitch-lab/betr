import { Bot } from "grammy";
import { env } from "./env.js";
import { registerCommands } from "./bot/commands.js";
import { registerMarketHandlers } from "./bot/market.js";
import { registerCallbacks } from "./bot/callbacks.js";

const bot = new Bot(env.BOT_TOKEN);

registerCommands(bot);
registerMarketHandlers(bot);
registerCallbacks(bot);

bot.catch((err) => {
  console.error("Bot error:", err);
});

bot.start();
console.log("Betr bot started!");
