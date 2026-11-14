// Runs once the test server is up (Playwright starts the web server before global setup): opens each page the tests
// visit, signed in, so `next dev` compiles them now and not in the middle of a test's first wait.
import { cookiesFor, seedExam, BASE_URL } from "./seed";

export default async function warmup() {
  const w = seedExam({ name: "Warm-up exam" });
  const cookie = cookiesFor(w.userId)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  const pages = ["/login", "/account", "/", `/exams/${w.examId}`, `/exams/${w.examId}/study`, "/attempts/0", "/admin"];
  for (const path of pages) {
    const res = await fetch(BASE_URL + path, { headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(180_000) });
    await res.arrayBuffer();
  }
}
