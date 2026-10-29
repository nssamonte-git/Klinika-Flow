import { createInterface, emitKeypressEvents } from "node:readline";
import { normalizeAccountEmail, normalizeAccountName, registerAccount, validatePassword } from "../src/server/accounts";
import { closeDb } from "../src/server/db-core";
import { stdin, stdout } from "node:process";

async function visible(prompt: string): Promise<string> {
  const reader = createInterface({ input: stdin, output: stdout });
  try { return await new Promise(resolve => reader.question(prompt, resolve)); } finally { reader.close(); }
}
async function hidden(prompt: string): Promise<string> {
  stdout.write(prompt); emitKeypressEvents(stdin); stdin.setRawMode(true); stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => { stdin.off("keypress", keypress); stdin.setRawMode(false); stdin.pause(); stdout.write("\n"); if (error) reject(error); else resolve(value); };
    const keypress = (text: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") return finish(new Error("Cancelled."));
      if (key.name === "return" || key.name === "enter") return finish();
      if (key.name === "backspace") { value = [...value].slice(0, -1).join(""); return; }
      if (text && !key.ctrl && !/[\u0000-\u001f\u007f]/.test(text)) value += text;
    };
    stdin.on("keypress", keypress);
  });
}
async function identity(prompt: string, validate: (value: string) => string) {
  while (true) {
    const value = await visible(prompt);
    try { return validate(value); } catch (error) { stdout.write(`${error instanceof Error ? error.message : "Check this field."}\n`); }
  }
}
async function passwordEntry() {
  while (true) {
    const password = await hidden("Password (15–128 characters, hidden): ");
    try { validatePassword(password); } catch (error) { stdout.write(`${error instanceof Error ? error.message : "Check the password length."}\n`); continue; }
    if (password === await hidden("Confirm password (hidden): ")) return password;
    stdout.write("Passwords do not match. Enter them again.\n");
  }
}
try {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("Run admin:create in an interactive terminal. Passwords are entered privately, never as command arguments.");
  const name = await identity("Administrator display name (required): ", normalizeAccountName);
  const email = await identity("Administrator email (required): ", normalizeAccountEmail);
  const password = await passwordEntry();
  await registerAccount(name, email, password, true);
  stdout.write("Administrator created. Open /sign-in and use this account. No shared studio token is needed.\n");
} catch (error) { stdout.write(`${error instanceof Error ? error.message : "Administrator creation failed."}\n`); process.exitCode = 1; }
finally { closeDb(); }
