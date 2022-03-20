import dotenv from "dotenv";

const env = process.env.ENV || "local";
const envFile = `ops/env/${env}.env`;

console.log(`Configured env=${env}, file=${envFile}`);
dotenv.config({ path: envFile });
