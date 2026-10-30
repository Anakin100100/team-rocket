import { Button } from "@rocket/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@rocket/ui/components/card";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { authClient } from "@/lib/auth-client";

const SCOPE_LABELS: Record<string, string> = {
  openid: "Confirm who you are",
  profile: "See your name and profile picture",
  email: "See your email address",
  offline_access: "Stay connected when you're not using the app",
};

// The authorization server signs this query; the oauthProviderClient plugin
// sends it back with the consent request, so only display fields are read here.
// zod's `.catch` (fallback on parse failure), not a promise chain.
// oxlint-disable-next-line promise/prefer-await-to-then, unicorn/no-useless-undefined
const searchString = z.coerce.string().optional().catch(undefined);
const consentSearchSchema = z.looseObject({
  client_id: searchString,
  scope: searchString,
});

const ConsentPage = () => {
  const { client_id: clientId = "", scope = "" } = Route.useSearch();
  const scopes = scope.split(" ").filter(Boolean);

  const client = useQuery({
    queryKey: ["oauth-public-client", clientId],
    queryFn: async () => {
      const { data, error } = await authClient.oauth2.publicClient({
        query: { client_id: clientId },
      });
      if (error) {
        throw new Error(error.message ?? "Unknown application");
      }
      return data;
    },
    enabled: clientId !== "",
  });

  // The response is `{ redirect: true, url }` back to the application (with a
  // code, or an access_denied error); Better Auth's client follows it.
  const consent = useMutation({
    mutationFn: async (accept: boolean) => {
      const { error } = await authClient.oauth2.consent({ accept });
      if (error) {
        throw new Error(error.message ?? "Could not complete authorization");
      }
    },
  });
  const isSubmitting = consent.isPending || consent.isSuccess;

  const clientName = client.data?.client_name ?? "An application";

  return (
    <div className="flex items-start justify-center p-4 md:p-8">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Connect {clientName} to Rocket</CardTitle>
          <CardDescription>
            {client.data?.client_uri ?? clientId}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p>It will be able to use Rocket as you, and:</p>
          <ul className="list-disc space-y-1 pl-5">
            {scopes.map((name) => (
              <li key={name}>{SCOPE_LABELS[name] ?? name}</li>
            ))}
          </ul>
          {consent.error ? (
            <p className="text-destructive">{consent.error.message}</p>
          ) : null}
        </CardContent>
        <CardFooter className="flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={isSubmitting}
            onClick={() => consent.mutate(false)}
          >
            Deny
          </Button>
          <Button
            disabled={isSubmitting || client.isError}
            onClick={() => consent.mutate(true)}
          >
            Allow
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
};

export const Route = createFileRoute("/_auth/oauth/consent")({
  validateSearch: consentSearchSchema,
  component: ConsentPage,
});
