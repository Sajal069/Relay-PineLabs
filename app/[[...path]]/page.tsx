import { Console } from "@/components/console";
import { AuthScreen } from "@/components/auth-screen";
import { workspaceHome } from "@/lib/access";
import { readSession, sessionCookie } from "@/lib/auth";
import { requiredChecks } from "@/lib/validation";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";

export default async function Page({ params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;
  const user = readSession((await cookies()).get(sessionCookie)?.value);
  if (!user) {
    if (path.length) redirect("/");
    return <AuthScreen/>;
  }
  const home = workspaceHome(user.role);
  if (!path.length) redirect(home);
  if (user.role === "merchant" && path[0] === "manager") redirect(home);
  if (user.role === "owner" && (path[0] === "inbox" || (
    path[0] === "applications" && (!path[1] || path[1] === "new" || path[2] === "correct")
  ))) redirect(home);
  return <Suspense><Console path={path} user={user} intakeChecks={requiredChecks()}/></Suspense>;
}
