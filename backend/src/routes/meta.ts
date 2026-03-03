import { Router } from "express";
import type { Request } from "express";
import { DESKTOP_DOWNLOAD_URL, PRODUCT_OPTIONS } from "../config";

const router = Router();

const toAbsoluteDownloadUrl = (req: Request): string => {
  const configured = DESKTOP_DOWNLOAD_URL.trim();
  if (!configured) {
    return "";
  }

  if (/^https?:\/\//i.test(configured)) {
    return configured;
  }

  if (!configured.startsWith("/")) {
    return configured;
  }

  const forwardedProto = req.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProto || req.protocol;
  const host = req.get("x-forwarded-host") ?? req.get("host");

  if (!host) {
    return configured;
  }

  return `${protocol}://${host}${configured}`;
};

router.get("/app-config", (req, res) => {
  res.json({
    productOptions: PRODUCT_OPTIONS,
    pages: ["Interview analyser", "Drilldown", "Assessments", "Assignments", "BigQuery"],
    interviewModules: ["Interview_analyser", "Video_uploader"],
    appName: "",
    version: "Integrated Pipeline v2.0",
    desktopDownloadUrl: toAbsoluteDownloadUrl(req),
  });
});

export default router;
