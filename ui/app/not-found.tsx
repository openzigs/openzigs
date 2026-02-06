import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-stone p-4 text-center text-ink">
      <h2 className="mb-4 text-2xl font-semibold">Not Found</h2>
      <p className="mb-6 opacity-70">Could not find requested resource</p>
      <Link
        href="/"
        className="rounded-full bg-ember px-6 py-2 text-sm font-semibold transition hover:opacity-80"
      >
        Return Home
      </Link>
    </div>
  );
}
