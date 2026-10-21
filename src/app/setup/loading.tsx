import { PageSkeleton } from "@/components/PageSkeleton";

// The API-key setup page isn't shaped like Home: a plain skeleton instead of the root (Home-shaped) one.
export default function Loading() {
  return <PageSkeleton />;
}
