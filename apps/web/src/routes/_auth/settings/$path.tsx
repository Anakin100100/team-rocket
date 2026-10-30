import { createFileRoute, notFound } from "@tanstack/react-router";

import { Settings } from "@/components/auth/settings/settings";
import { settingsPaths } from "@/lib/auth-view-paths";

const RouteComponent = () => {
  const { path } = Route.useParams();

  return (
    <div className="mx-auto w-full max-w-4xl p-4 md:p-8">
      <Settings path={path} />
    </div>
  );
};

export const Route = createFileRoute("/_auth/settings/$path")({
  beforeLoad: ({ params }) => {
    if (!settingsPaths.has(params.path)) {
      throw notFound();
    }
  },
  component: RouteComponent,
});
