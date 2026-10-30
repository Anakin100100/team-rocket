import { createFileRoute, notFound } from "@tanstack/react-router";

import { Organization } from "@/components/auth/organization/organization";
import { organizationPaths } from "@/lib/auth-view-paths";

const RouteComponent = () => {
  const { path } = Route.useParams();

  return (
    <div className="mx-auto w-full max-w-4xl p-4 md:p-8">
      <Organization path={path} />
    </div>
  );
};

export const Route = createFileRoute("/_auth/organization/$path")({
  beforeLoad: ({ params }) => {
    if (!organizationPaths.has(params.path)) {
      throw notFound();
    }
  },
  component: RouteComponent,
});
