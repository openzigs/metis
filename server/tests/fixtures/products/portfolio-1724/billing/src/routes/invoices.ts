type Handler = (req: { params: Record<string, string> }, res: { json(v: unknown): void }) => void;
interface Router {
  get(path: string, h: Handler): void;
}
declare const router: Router;

router.get("/invoices/:id", (req, res) => {
  res.json({ id: req.params.id });
});
