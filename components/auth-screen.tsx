"use client";

import { useState, type FormEvent } from "react";
import { ArrowRight, Building2, Eye, EyeOff, Inbox, ShieldCheck } from "lucide-react";
import { requestJson } from "./submission";
import { InlineError, RelayLogo, Spinner } from "./ui";

export function AuthScreen() {
  const [role, setRole] = useState<"owner" | "merchant">("merchant");
  const [register, setRegister] = useState(false);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isOwner = role === "owner";
  const isSignUp = !isOwner && register;

  function selectRole(next: typeof role) {
    setRole(next);
    setRegister(false);
    setVisible(false);
    setError("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await requestJson<{ home: string }>("/api/relay/session", {
        action: isSignUp ? "signUp" : "signIn",
        role,
        id: form.get("owner-id"),
        name: form.get("name"),
        email: form.get("email"),
        password: form.get("password"),
      });
      window.location.replace(result.home);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed. Try again.");
      setBusy(false);
    }
  }

  return <main className="access-layout">
    <section className="access-brand-panel" aria-label="About Relay">
      <div className="brand"><RelayLogo subtitle="Merchant onboarding"/></div>
      <div className="access-brand-copy">
        <h2>From application to approval</h2>
        <p>Submit merchant documents, track verification, and respond to correction requests.</p>
        <div className="access-brand-detail">
          <span className="access-brand-icon"><Inbox size={19}/></span>
          <div><strong>Merchant inbox</strong><span>See what needs your attention and send updated evidence.</span></div>
        </div>
        <div className="access-brand-detail">
          <span className="access-brand-icon"><ShieldCheck size={19}/></span>
          <div><strong>Owner review</strong><span>Review applications and make approval decisions.</span></div>
        </div>
      </div>
      <span className="access-environment"><span className="env-dot"/>Relay sandbox</span>
    </section>
    <section className="access-content">
      <div className="panel access-card">
        <div className="access-switch" role="group" aria-label="Workspace">
          <button type="button" aria-pressed={!isOwner} disabled={busy} onClick={() => selectRole("merchant")}>
            <Building2 size={16}/>Merchant
          </button>
          <button type="button" aria-pressed={isOwner} disabled={busy} onClick={() => selectRole("owner")}>
            <ShieldCheck size={16}/>Owner
          </button>
        </div>
        <div className="access-title">
          <h1>{isOwner ? "Owner sign in" : isSignUp ? "Create a merchant account" : "Merchant sign in"}</h1>
          <p>{isOwner ? "Open the manager dashboard with your owner credentials."
            : isSignUp ? "Create an account to submit and track your applications."
              : "Access your applications and correction inbox."}</p>
        </div>
        <form key={role + String(register)} className="access-form" onSubmit={submit}>
          {isSignUp && <label className="field"><span>Full name</span>
            <input name="name" required maxLength={80} autoComplete="name" placeholder="Your name"/></label>}
          {isOwner ? <label className="field"><span>Owner ID</span>
            <input name="owner-id" required autoComplete="username" maxLength={254} placeholder="Enter your owner ID"/></label>
            : <label className="field"><span>Email</span>
              <input type="email" name="email" required autoComplete={isSignUp ? "email" : "username"} maxLength={254} placeholder="you@example.com"/></label>}
          <div className="field">
            <label htmlFor="workspace-password">Password</label>
            <div className="reveal-input">
              <input id="workspace-password" name="password" type={visible ? "text" : "password"} required maxLength={128}
                minLength={isSignUp ? 12 : undefined} autoComplete={isSignUp ? "new-password" : "current-password"}
                aria-describedby={isSignUp ? "password-guide" : undefined} placeholder={isSignUp ? "Create a password" : "Enter your password"}/>
              <button type="button" className="icon-button" aria-label={visible ? "Hide password" : "Show password"} onClick={() => setVisible(value => !value)}>
                {visible ? <EyeOff size={17}/> : <Eye size={17}/>}
              </button>
            </div>
            {isSignUp && <p className="access-password-guide" id="password-guide">Use at least 12 characters.</p>}
          </div>
          {error && <InlineError message={error}/>}
          <button className="button primary access-submit" disabled={busy}>
            {busy && <Spinner/>}{isSignUp ? "Create account" : "Sign in"}{!busy && <ArrowRight size={17}/>}
          </button>
        </form>
        {!isOwner && <p className="access-mode-copy">{isSignUp ? "Already have an account?" : "New to Relay?"}
          <button type="button" disabled={busy} onClick={() => {
            setRegister(value => !value);
            setVisible(false);
            setError("");
          }}>{isSignUp ? "Sign in" : "Create an account"}</button>
        </p>}
      </div>
    </section>
  </main>;
}
