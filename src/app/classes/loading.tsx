import { PageSkeleton } from "@/components/PageSkeleton";

// Pages that are not shaped like Home get a plain skeleton instead of the root (Home-shaped) one.
export default function Loading() {
  return <PageSkeleton />;
}
