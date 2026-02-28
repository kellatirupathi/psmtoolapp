import { Router } from "express";
import { getProviderSettings, saveProviderSettings } from "../services/settingsService";

const router = Router();

router.get("/provider-config", async (_req, res) => {
  try {
    const settings = await getProviderSettings();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

router.put("/provider-config", async (req, res) => {
  try {
    const saved = await saveProviderSettings(req.body ?? {});
    res.json(saved);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

export default router;
