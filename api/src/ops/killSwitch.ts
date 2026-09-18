// Lambda subscribed to the budget "trip" SNS topic: turns the kill switch on.
import { PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

export type WriteFlag = (value: "on") => Promise<void>;

export async function trip(write: WriteFlag, event: unknown): Promise<void> {
  await write("on");
  console.warn(JSON.stringify({ level: "warn", message: "Kill switch turned on by budget alert", event }));
}

const client = new SSMClient({});
const name = process.env.KILL_SWITCH_PARAMETER;

export const handler = async (event: unknown): Promise<void> => {
  if (!name) throw new Error("KILL_SWITCH_PARAMETER is not set");
  await trip(async (value) => {
    await client.send(new PutParameterCommand({ Name: name, Value: value, Type: "String", Overwrite: true }));
  }, event);
};
