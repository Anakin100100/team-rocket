import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@rocket/ui/components/table";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";

import Loader from "@/components/loader";
import { orpc } from "@/utils/orpc";

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const FeedbackPage = () => {
  const feedback = useQuery(orpc.feedback.list.queryOptions());

  if (feedback.isPending) {
    return <Loader />;
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 md:p-8">
      <div>
        <h1 className="text-lg font-medium">Feedback</h1>
        <p className="text-muted-foreground text-sm">
          Sent by users through the Rocket MCP server, newest first.
        </p>
      </div>
      {feedback.data?.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Created at</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Feedback</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {feedback.data.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="align-top">
                  <time dateTime={item.createdAt.toISOString()}>
                    {dateFormat.format(item.createdAt)}
                  </time>
                </TableCell>
                <TableCell className="align-top">{item.name}</TableCell>
                <TableCell className="align-top">{item.email}</TableCell>
                <TableCell className="min-w-64 align-top break-words whitespace-pre-wrap">
                  {item.text}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-muted-foreground py-8 text-center text-sm">
          No feedback yet.
        </p>
      )}
    </div>
  );
};

export const Route = createFileRoute("/_auth/feedback")({
  // The API enforces this too; the redirect only keeps non-admins off the page.
  beforeLoad: async ({ context }) => {
    const canView = await context.queryClient.fetchQuery(
      context.orpc.isAdmin.queryOptions()
    );
    if (!canView) {
      throw redirect({ to: "/dashboard" });
    }
  },
  component: FeedbackPage,
});
