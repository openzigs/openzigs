export default function InviteExpiredPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-center space-y-4 max-w-md px-6">
        <div className="text-4xl">⏰</div>
        <h1 className="text-xl font-bold text-foreground">Invite Expired</h1>
        <p className="text-muted-foreground">
          This invite link has expired or is no longer valid. Please ask the host to send you a new one.
        </p>
      </div>
    </div>
  );
}
