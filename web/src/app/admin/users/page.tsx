import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ACCOUNT_COOKIE, accountSession } from "@backend/server/accounts";
import AccountScreens from "../../../components/account-screens";
export const dynamic = "force-dynamic";
export default async function Page() {
  const session = accountSession((await cookies()).get(ACCOUNT_COOKIE)?.value);
  if (!session) redirect("/sign-in");
  if (session.user.role !== "admin" || session.user.status !== "active") redirect("/account");
  return <AccountScreens screen="admin" />;
}
