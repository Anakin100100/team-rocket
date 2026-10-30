import { Badge } from "@rocket/ui/components/badge";

import type { ThreadState } from "./state";

const VARIANT: Record<
  ThreadState,
  "default" | "secondary" | "outline" | "destructive"
> = {
  open: "outline",
  agreed: "default",
  abandoned: "destructive",
  superseded: "secondary",
};

export const ThreadStateBadge = ({ state }: { state: ThreadState }) => (
  <Badge variant={VARIANT[state]}>{state}</Badge>
);
