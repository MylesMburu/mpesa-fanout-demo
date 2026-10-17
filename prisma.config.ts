import { config } from "dotenv";
import { defineConfig } from "prisma/config";

config();

// Prisma 7 reads the connection string here, not from schema.prisma.
// Next.js loads .env for the running app; this file loads it for the CLI.
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
