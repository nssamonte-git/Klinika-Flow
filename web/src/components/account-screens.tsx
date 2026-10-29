"use client";
import { useEffect, useState } from "react";
import type { User } from "@backend/server/accounts";
import type { TextUsageSummary } from "@backend/domain/text-usage";
import TokenUsagePanel from "./token-usage-panel";
type Usage = { estimatedUsd: number; actualUsd: number; unknownCalls: number; text?: TextUsageSummary };
type Directory = { users: (User & { usage: Usage })[]; usage: Usage; unattributedUsage: { calls: number; actualUsd: number; estimatedUsd: number } };
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || "The request could not be completed."); return data;
}
const date = (value: number | null) => value ? new Date(value).toLocaleString() : "Not recorded";
const cost = (usage: Usage) => `$${usage.actualUsd.toFixed(5)} recorded · $${usage.estimatedUsd.toFixed(5)} attempted estimate · ${usage.unknownCalls} unknown`;
export default function AccountScreens({ screen }: { screen: "sign-in" | "sign-up" | "account" | "reset-password" | "admin" }) {
  const [user, setUser] = useState<User | null>(null), [usage, setUsage] = useState<Usage | null>(null), [directory, setDirectory] = useState<Directory | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [resetLink, setResetLink] = useState(""), [resetExpiry, setResetExpiry] = useState(0), [token, setToken] = useState(""), [canImport, setCanImport] = useState(false);
  async function load() {
    const account = await request<{ user: User; usage: Usage }>("/api/auth"); setUser(account.user); setUsage(account.usage);
    if (screen === "admin") setDirectory(await request<Directory>("/api/admin/users"));
    if (screen === "account" && account.user.status === "active") setCanImport((await request<{ available: boolean }>("/api/account/import")).available);
  }
  useEffect(() => {
    if (screen === "account" || screen === "admin") void load().catch(err => setError(err.message));
    if (screen === "reset-password") { setToken(new URLSearchParams(window.location.hash.slice(1)).get("token") ?? ""); window.history.replaceState(null, "", "/reset-password"); }
    // Each screen loads once; later status checks are explicit user actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);
  async function work(task: () => Promise<void>) { if (busy) return; setBusy(true); setError(""); setNotice(""); try { await task(); } catch(err) { setError(err instanceof Error ? err.message : "Please try again."); } finally { setBusy(false); } }
  async function submit(form: HTMLFormElement) {
    const values = new FormData(form), password = String(values.get("password") ?? "");
    if ((screen !== "sign-in") && password !== values.get("confirmPassword")) { setError("The passwords do not match."); return; }
    await work(async () => {
      if (screen === "account") { await request("/api/auth", { action: "change-password", currentPassword: values.get("currentPassword"), password }); window.location.assign("/sign-in?changed=1"); }
      else if (screen === "reset-password") { await request("/api/auth", { action: "reset-password", token, password }); setToken(""); form.reset(); setNotice("Password reset. Sign in with your new password."); }
      else { await request("/api/auth", { action: screen === "sign-up" ? "register" : "login", ...(screen === "sign-up" ? { name: values.get("name") } : {}), email: values.get("email"), password }); window.location.assign(screen === "sign-up" ? "/account" : "/"); }
    });
  }
  const heading = screen === "sign-in" ? "Sign in" : screen === "sign-up" ? "Create your account" : screen === "admin" ? "Manage users" : screen === "reset-password" ? "Reset your password" : "Your account";
  return <main className={`account-shell ${screen === "admin" ? "account-wide" : ""}`}><a className="account-brand" href="/">KlinikaFlow</a><nav className="account-navigation" aria-label="Account navigation"><a href="/?demo=1">Saved Demo</a>{user?.status === "active" && <a href="/?workspace=1">Workspace</a>}{user && <a href="/account">Account</a>}{user?.role === "admin" && user.status === "active" && <a href="/admin/users">Manage users</a>}{user ? <button disabled={busy} className="text-link" onClick={() => work(async () => { await request("/api/auth", { action: "logout" }); window.location.assign("/sign-in"); })}>Sign out</button> : <a href="/sign-in">Sign in</a>}</nav><section className="panel account-panel"><h1>{heading}</h1><p className="muted">Synthetic encounters only. No real patient information.</p>{error && <p className="alert error" role="alert">{error}</p>}<p role="status" aria-live="polite">{busy ? "Saving…" : notice}</p>
    {screen === "sign-in" || screen === "sign-up" || screen === "reset-password" ? <>
      {screen === "sign-up" && <p>Create an account, then wait for administrator approval. Your email address is not verified by this prototype.</p>}
      <form className="account-form" onSubmit={event => { event.preventDefault(); void submit(event.currentTarget); }}>
        {screen === "sign-up" && <label className="field">Display name<input name="name" required maxLength={80} autoComplete="name" /></label>}
        {screen !== "reset-password" && <label className="field">Email address<input name="email" type="email" required maxLength={254} autoComplete="email" /></label>}
        <label className="field">{screen === "reset-password" ? "New password" : "Password"}<input name="password" type="password" required minLength={screen === "sign-in" ? undefined : 15} maxLength={256} autoComplete={screen === "sign-in" ? "current-password" : "new-password"} /></label>
        {screen !== "sign-in" && <><small>Use 15–128 characters. Spaces and password managers are welcome.</small><label className="field">Confirm password<input name="confirmPassword" type="password" required autoComplete="new-password" /></label></>}
        <button className="button primary" disabled={busy || (screen === "reset-password" && !token)}>{screen === "sign-in" ? "Sign in" : screen === "sign-up" ? "Create account" : "Set new password"}</button>
      </form>
      {screen === "sign-in" && <><p>New here? <a href="/sign-up">Create an account</a>.</p><p className="muted">Forgot your password? Ask your administrator for a single-use reset link.</p></>}
      {screen === "sign-up" && <p>Already registered? <a href="/sign-in">Sign in</a>.</p>}
      {screen === "reset-password" && <p><a href="/sign-in">Return to sign in</a>. Ask your administrator for a new link if yours has expired.</p>}
    </> : screen === "account" && user ? <>
      <h2>{user.name}</h2><p>{user.email} · {user.role} · <strong>{user.status}</strong></p>
      {user.status === "pending" ? <div className="source-note"><h2>Awaiting approval</h2><p>Your administrator must approve your account before you can use the workspace. You can explore Saved Demo while waiting.</p><button className="button secondary" disabled={busy} onClick={() => work(load)}>Refresh approval status</button></div> : user.status === "active" ? <p><a className="button primary" href="/?workspace=1">Open workspace</a></p> : <p>Contact your administrator to restore access.</p>}
      <p className="small muted">Email ownership is unverified. Last sign-in: {date(user.lastLogin)}.</p>
      {user.status === "active" && <><h2>Your model usage</h2>{usage && <><p>{cost(usage)}</p><TokenUsagePanel usage={usage.text} /></>}{canImport && <section className="source-note"><h2>Import this browser’s work</h2><p>Move this browser’s existing demo or legacy workspace into your account. Existing records keep their original history. This is a one-time transfer.</p><button className="button secondary" disabled={busy} onClick={() => { if (window.confirm("Import this browser’s existing workspace into your account?")) void work(async () => { await request("/api/account/import", { confirmed: true }); setCanImport(false); setNotice("Workspace imported. Open your workspace to view its saved encounters."); }); }}>Import browser workspace</button></section>}</>}
      {user.status !== "suspended" && <><h2>Change password</h2><form className="account-form" onSubmit={event => { event.preventDefault(); void submit(event.currentTarget); }}><label className="field">Current password<input name="currentPassword" type="password" required autoComplete="current-password" /></label><label className="field">New password<input name="password" type="password" required minLength={15} maxLength={256} autoComplete="new-password" /></label><label className="field">Confirm new password<input name="confirmPassword" type="password" required autoComplete="new-password" /></label><p className="small muted">Use 15–128 characters. Changing your password signs out every session.</p><button className="button secondary" disabled={busy}>Change password</button></form></>}
    </> : screen === "admin" && directory ? <>
      <p>You can manage access and usage here. Encounter content and recordings are private to each account.</p><button className="button secondary" disabled={busy} onClick={() => work(load)}>Refresh users</button>
      <h2>All API usage</h2><p>{cost(directory.usage)}</p><p className="small muted">Historical / CLI usage without an account: {directory.unattributedUsage.calls} calls · ${directory.unattributedUsage.actualUsd.toFixed(5)} recorded. Unknown ownership is preserved.</p><TokenUsagePanel usage={directory.usage.text} />
      {resetLink && <div className="source-note" role="status"><h2>Single-use reset link</h2><p>Share privately with this user. Expires {date(resetExpiry)}. This link is shown only until you dismiss it or leave this page.</p><label className="field">Reset link<input readOnly value={resetLink} onFocus={event => event.currentTarget.select()} /></label><button className="button secondary" onClick={() => setResetLink("")}>Dismiss link</button></div>}
      <div className="account-users">{directory.users.map(person => <article className="account-user" key={person.id}><h2>{person.name}</h2><p>{person.email} · {person.role} · <strong>{person.status}</strong></p><p className="small muted">Registered: {date(person.created)}<br />{person.approvedAt ? person.approvedBy ? `Approved: ${date(person.approvedAt)} by ${directory.users.find(u => u.id === person.approvedBy)?.name ?? "Administrator"}` : `Provisioned from terminal: ${date(person.approvedAt)}` : "Not approved"}<br />Last sign-in: {date(person.lastLogin)}</p><p className="small">{cost(person.usage)}</p><div className="button-row">{(person.status === "pending" ? ["approve", "suspend", "reset-password"] : person.status === "suspended" ? ["restore"] : ["suspend", "reset-password"]).map(action => <button key={action} className="button secondary" disabled={busy || (action === "suspend" && person.role === "admin" && person.status === "active" && directory.users.filter(item => item.role === "admin" && item.status === "active").length === 1)} onClick={() => { if ((action === "suspend" || action === "reset-password") && !window.confirm(`${action === "suspend" ? "Suspend access and end all sessions" : "Generate a private password-reset link"} for ${person.email}?`)) return; void work(async () => { setResetLink(""); const result = await request<{ resetUrl?: string; expires?: number }>("/api/admin/users", { userId: person.id, action, confirmed: true }); if (result.resetUrl) { setResetLink(`${window.location.origin}${result.resetUrl}`); setResetExpiry(result.expires!); } await load(); setNotice("Account action completed."); }); }}>{action === "approve" ? "Approve access" : action === "suspend" ? "Suspend" : action === "restore" ? "Restore access" : "Create reset link"}</button>)}</div></article>)}</div>
    </> : <p>{error ? <a href="/sign-in">Sign in to continue</a> : "Loading your account…"}</p>}
    </section></main>;
}
