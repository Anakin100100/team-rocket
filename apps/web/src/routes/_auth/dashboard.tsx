import { Button } from "@rocket/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@rocket/ui/components/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@rocket/ui/components/tabs";
import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";

import { ENV } from "@/env";
import { getServerUrl } from "@/utils/orpc";

const COPIED_RESET_MS = 2000;
const MCP_SERVER_NAME = "rocket";

const CopyableSnippet = ({ text, label }: { text: string; label: string }) => {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_RESET_MS);
    } catch {
      toast.error("Couldn't copy. Select the text and copy it manually.");
    }
  };

  return (
    <div className="flex items-start gap-2">
      <pre className="bg-muted min-w-0 flex-1 overflow-x-auto border px-3 py-2 font-mono text-xs">
        {text}
      </pre>
      <Button
        variant="outline"
        size="icon"
        aria-label={copied ? "Copied" : label}
        onClick={copy}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
};

const SetupSteps = ({ children }: { children: ReactNode }) => (
  <ol className="flex list-decimal flex-col gap-3 pl-5 text-sm">{children}</ol>
);

const ClaudeCodeSteps = ({ url }: { url: string }) => (
  <SetupSteps>
    <li className="flex flex-col gap-2">
      Add the server from your terminal:
      <CopyableSnippet
        label="Copy command"
        text={`claude mcp add --transport http ${MCP_SERVER_NAME} ${url}`}
      />
    </li>
    <li>
      Start Claude Code and run <code>/mcp</code>.
    </li>
    <li>
      Select <strong>{MCP_SERVER_NAME}</strong>, choose{" "}
      <strong>Authenticate</strong>, then sign in and approve access in the
      browser window that opens.
    </li>
  </SetupSteps>
);

const CodexSteps = ({ url }: { url: string }) => (
  <SetupSteps>
    <li className="flex flex-col gap-2">
      Add the server from your terminal:
      <CopyableSnippet
        label="Copy command"
        text={`codex mcp add ${MCP_SERVER_NAME} --url ${url} --oauth-resource ${url}`}
      />
    </li>
    <li className="flex flex-col gap-2">
      Sign in, then approve access in the browser window that opens:
      <CopyableSnippet
        label="Copy command"
        text={`codex mcp login ${MCP_SERVER_NAME}`}
      />
    </li>
    <li>
      Start Codex and run <code>/mcp</code> to confirm the Rocket tools are
      listed.
    </li>
  </SetupSteps>
);

const CursorSteps = ({ url }: { url: string }) => {
  const config = { url };
  const installLink = `cursor://anysphere.cursor-deeplink/mcp/install?name=${MCP_SERVER_NAME}&config=${btoa(JSON.stringify(config))}`;
  const configFile = JSON.stringify(
    { mcpServers: { [MCP_SERVER_NAME]: config } },
    null,
    2
  );

  return (
    <SetupSteps>
      <li className="flex flex-col items-start gap-2">
        Install the server in Cursor:
        <Button
          render={<a href={installLink} aria-label="Add to Cursor" />}
          nativeButton={false}
        >
          Add to Cursor
        </Button>
        <span className="text-muted-foreground text-xs">
          Or add it to <code>~/.cursor/mcp.json</code> yourself:
        </span>
        <div className="w-full">
          <CopyableSnippet label="Copy config" text={configFile} />
        </div>
      </li>
      <li>
        Open <strong>Cursor Settings → Tools &amp; MCP</strong> and click{" "}
        <strong>Connect</strong> next to <strong>{MCP_SERVER_NAME}</strong>.
      </li>
      <li>Sign in and approve access in the browser window that opens.</li>
    </SetupSteps>
  );
};

const McpSetup = () => {
  const url = `${getServerUrl(ENV.VITE_SERVER_URL)}/mcp`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect your AI tools</CardTitle>
        <CardDescription>
          Connect the Rocket MCP server to your coding agent. You&apos;ll sign
          in with your Rocket account and approve access.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="claude-code">
          <TabsList>
            <TabsTrigger value="claude-code">Claude Code</TabsTrigger>
            <TabsTrigger value="codex">Codex</TabsTrigger>
            <TabsTrigger value="cursor">Cursor</TabsTrigger>
          </TabsList>
          <TabsContent value="claude-code" className="pt-2">
            <ClaudeCodeSteps url={url} />
          </TabsContent>
          <TabsContent value="codex" className="pt-2">
            <CodexSteps url={url} />
          </TabsContent>
          <TabsContent value="cursor" className="pt-2">
            <CursorSteps url={url} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
};

const RouteComponent = () => {
  const { session } = Route.useRouteContext();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-8">
      <div>
        <h1 className="text-lg font-medium">Dashboard</h1>
        <p>Welcome {session.data?.user.name}</p>
      </div>
      <McpSetup />
    </div>
  );
};

export const Route = createFileRoute("/_auth/dashboard")({
  component: RouteComponent,
});
