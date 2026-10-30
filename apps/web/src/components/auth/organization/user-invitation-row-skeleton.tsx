"use client"

import { Item, ItemContent, ItemMedia } from "@rocket/ui/components/item"
import { Skeleton } from "@rocket/ui/components/skeleton"

/**
 * Placeholder row matching `UserInvitationRow` while invitations load.
 */
export function UserInvitationRowSkeleton() {
  return (
    <Item>
      <ItemMedia>
        <Skeleton className="size-10 shrink-0 rounded-md" />
      </ItemMedia>
      <ItemContent>
        <Skeleton className="h-4 w-40 rounded-md" />
        <Skeleton className="h-3 w-28 rounded-md" />
      </ItemContent>
    </Item>
  )
}
