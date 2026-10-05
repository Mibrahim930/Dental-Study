import { redirect } from "next/navigation";
import { currentUser } from "@/lib/user";
import { KeyForm } from "@/components/KeyForm";
import { Brand } from "@/components/Brand";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const user = await currentUser();
  if (!user) redirect("/account");
  return (
    <div className="mx-auto mt-8 sm:mt-14 max-w-lg">
      <Brand />
      <div className="card space-y-4">
        <div>
          <h1 className="text-xl font-semibold">Connect your AI</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Dental Study uses AI to read your lecture slides, teach topics, and write practice exams. Add your own Claude or ChatGPT API
            key to get started. You only pay for what you use, usually a few dollars per exam.
          </p>
        </div>
        <KeyForm initialProvider={user.provider} done="/" />
      </div>
    </div>
  );
}
