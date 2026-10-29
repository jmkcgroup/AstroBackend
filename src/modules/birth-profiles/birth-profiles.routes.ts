import { Router } from "express";
import { z } from "zod";
import { currentUser, requireAuth } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import * as svc from "./birth-profiles.service.js";

export const birthProfilesRouter = Router();
birthProfilesRouter.use(requireAuth);

const idParams = z.object({ id: z.string().min(1).max(40) });

birthProfilesRouter.get("/", async (req, res) => {
  res.json({ items: await svc.listProfiles(currentUser(req).userId) });
});

birthProfilesRouter.post("/", validate({ body: svc.birthProfileInput }), async (req, res) => {
  res.status(201).json({ profile: await svc.createProfile(currentUser(req).userId, req.body) });
});

birthProfilesRouter.get("/:id", validate({ params: idParams }), async (req, res) => {
  const profile = await svc.getOwnedProfile(currentUser(req).userId, req.params.id as string);
  res.json({ profile: svc.serializeProfile(profile) });
});

birthProfilesRouter.put("/:id", validate({ params: idParams, body: svc.birthProfileInput }), async (req, res) => {
  res.json({ profile: await svc.updateProfile(currentUser(req).userId, req.params.id as string, req.body) });
});

birthProfilesRouter.post("/:id/primary", validate({ params: idParams }), async (req, res) => {
  await svc.setPrimary(currentUser(req).userId, req.params.id as string);
  res.json({ ok: true });
});

birthProfilesRouter.delete("/:id", validate({ params: idParams }), async (req, res) => {
  await svc.deleteProfile(currentUser(req).userId, req.params.id as string);
  res.status(204).end();
});
