import { PageSkeleton } from "@/components/PageSkeleton";

// Help pages aren't shaped like Home: a plain skeleton instead of the root (Home-shaped) one.
export default function Loading() {
  return <PageSkeleton />;
}
