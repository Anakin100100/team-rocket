import { Button } from "@rocket/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@rocket/ui/components/card";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { ENV } from "@/env";
import { getServerUrl, orpc } from "@/utils/orpc";

const COPIED_RESET_MS = 2000;

const ClaudeCodeSetup = () => {
  const [copied, setCopied] = useState(false);
  const command = `claude mcp add --transport http rocket ${getServerUrl(ENV.VITE_SERVER_URL)}/mcp`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_RESET_MS);
    } catch {
      toast.error("Couldn't copy. Select the command and copy it manually.");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect Claude Code</CardTitle>
        <CardDescription>
          Run this in your terminal, then run <code>/mcp</code> in Claude Code
          and pick <strong>rocket</strong> to sign in and approve access.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex items-center gap-2">
        <code className="bg-muted min-w-0 flex-1 overflow-x-auto border px-3 py-2 font-mono text-xs whitespace-nowrap">
          {command}
        </code>
        <Button
          variant="outline"
          size="icon"
          aria-label={copied ? "Copied" : "Copy command"}
          onClick={copy}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </CardContent>
    </Card>
  );
};

const RouteComponent = () => {
  const { session } = Route.useRouteContext();

  const privateData = useQuery(orpc.privateData.queryOptions());

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-8">
      <div>
        <h1 className="text-lg font-medium">Dashboard</h1>
        <p>Welcome {session.data?.user.name}</p>
        <p className="text-muted-foreground text-sm">
          API: {privateData.data?.message}
        </p>
      </div>
      <ClaudeCodeSetup />
    </div>
  );
};

export const Route = createFileRoute("/_auth/dashboard")({
  component: RouteComponent,
});
