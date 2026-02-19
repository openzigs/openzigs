export default function ForbiddenPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-center space-y-4 max-w-md px-6">
        <div className="text-6xl font-bold text-muted-foreground/30">403</div>
        <h1 className="text-xl font-bold text-foreground">Access Denied</h1>
        <p className="text-muted-foreground">
          You don&apos;t have permission to access this page. Guest accounts can only view the shared presentation.
        </p>
      </div>
    </div>
  );
}
