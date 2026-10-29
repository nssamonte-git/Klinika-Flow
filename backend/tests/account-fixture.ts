import { randomUUID } from "node:crypto";
import { db } from "../src/server/db-core";
import { createAccountSession } from "../src/server/accounts";
// Synthetic accounts bypass expensive password derivation only inside test fixtures.
export function createStudio() {
  const id = randomUUID(), workspace = randomUUID();
  db().prepare("INSERT INTO users(id,name,email,password,role,status,created) VALUES(?,?,?,'test-only','member','active',?)").run(id, "Demo", `${id}@example.test`, Date.now());
  db().prepare("INSERT INTO workspaces(id,user_id,kind) VALUES(?,?,'account')").run(workspace, id);
  const { token, session } = createAccountSession(id);
  return { ...session, token };
}
