import Link from "next/link";

export default function NotFound() {
  return (
    <main
      className="container"
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 14,
      }}
    >
      <div className="kicker">404</div>
      <h1 className="h2">Такой страницы нет</h1>
      <p className="lead">Возможно, ссылка устарела или проект ещё не опубликован.</p>
      <p style={{ marginTop: 12, fontSize: 19 }}>
        <Link href="/">← На главную</Link>
      </p>
    </main>
  );
}
