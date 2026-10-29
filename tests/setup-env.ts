// Runs before every test file: point the app at the isolated test database.
import "dotenv/config";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "file:./test.db";
process.env.SWISSEPH_EPHE_PATH = "./ephe";
// Email is logged instead of sent during tests.
process.env.SMTP_HOST = "";
// Test-only Razorpay credentials: signatures are computed locally and a fake gateway
// (tests/fake-gateway.ts) replaces every network call.
process.env.RAZORPAY_KEY_ID = "rzp_test_localonly";
process.env.RAZORPAY_KEY_SECRET = "test-key-secret-not-real";
process.env.RAZORPAY_WEBHOOK_SECRET = "test-webhook-secret-not-real";
// Generated PDFs go to a throwaway directory.
process.env.STORAGE_DIR = path.join(os.tmpdir(), "astroveda-test-storage");
