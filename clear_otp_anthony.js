/**
 * clear_otp_anthony.js
 * One-time helper: logs into mywfg.com as Anthony Augugliaro (direct login,
 * NOT agent-assistant), handles the OTP challenge by waiting for
 * otp_code.txt to appear (drop the code Brilynn reads from Anthony's email),
 * checks "Remember This Device" so future fc_run_anthony.js runs skip OTP,
 * and persists the trusted-device cookie into mywfg_profile_anthony/.
 * Usage: node clear_otp_anthony.js
 *   (then, once it prints "AUTHORIZATION CODE REQUIRED", write the code to
 *    otp_code.txt in this directory)
 */
require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PROFILE_DIR = path.join(__dirname, 'mywfg_profile_anthony');
const LOGIN_URL = 'https://www.mywfg.com/';

async function isLoginPage(page) {
  if (page.url().includes('macotp')) return true;
  const loginBtn = await page.locator('button:has-text("Log in")').count();
  return loginBtn > 0;
}

(async () => {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true, args: ['--no-sandbox'],
  });
  const page = context.pages()[0] || await context.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });

  try {
    console.log('Navigating to mywfg.com...');
    await page.goto(LOGIN_URL);
    await page.waitForLoadState('load', { timeout: 20000 });

    if (!(await isLoginPage(page))) {
      console.log('Already logged in — no OTP needed. Nothing to do.');
      await context.close();
      return;
    }

    console.log('Login form detected — filling Anthony\'s credentials...');
    await page.waitForSelector('input[type="password"]', { timeout: 15000 });
    const agentInput = page.locator('input[placeholder*="User"], input[placeholder*="Agent"], input[type="text"]').first();
    await agentInput.fill(process.env.MYWFG_USERNAME_ANTHONY);
    await page.fill('input[type="password"]', process.env.MYWFG_PASSWORD_ANTHONY);
    // Deliberately NOT checking "I'm an agent assistant" — direct login.

    await page.click('button:has-text("Log in")');
    await page.waitForTimeout(4000);

    if (page.url().includes('macotp')) {
      // Confirmed via probe_otp_page.js: the actual visible OTP field is
      // #mywfgOtppswd (type="password", despite being a numeric code — NOT
      // input[type="text"], which is what the Olivia-flow script assumed and
      // which doesn't match here, causing a 30s locator timeout). Submit
      // button is #mywfgTheylive; there are multiple hidden duplicate
      // inputs/buttons for other OTP delivery methods (SMS/pulse) on the same
      // page, so ID-scoped selectors are required, not generic type selectors.
      const rememberBox = page.locator('#mywfgRememberDevice');
      if (await rememberBox.count() > 0 && !(await rememberBox.isChecked())) {
        await rememberBox.check();
        console.log('  Checked "Remember This Device"');
      }

      const otpCodeFile = path.join(__dirname, 'otp_code.txt');
      const otpReadyFile = path.join(__dirname, 'otp_needed.txt');
      if (fs.existsSync(otpCodeFile)) fs.unlinkSync(otpCodeFile);
      fs.writeFileSync(otpReadyFile, new Date().toISOString());

      console.log('\n  *** AUTHORIZATION CODE REQUIRED ***');
      console.log('  Marker written to otp_needed.txt — waiting for otp_code.txt...\n');

      const deadline = Date.now() + 240000; // 4 min — human needs to check email
      while (!fs.existsSync(otpCodeFile)) {
        if (Date.now() > deadline) throw new Error('OTP timeout — otp_code.txt not provided within 4 minutes');
        await page.waitForTimeout(1000);
      }

      const otpCode = fs.readFileSync(otpCodeFile, 'utf8').trim();
      fs.unlinkSync(otpCodeFile);
      fs.unlinkSync(otpReadyFile);
      console.log(`  Got OTP code: ${otpCode}`);

      const otpInput = page.locator('#mywfgOtppswd');
      await otpInput.waitFor({ state: 'visible', timeout: 10000 });
      await otpInput.fill(otpCode);
      await page.locator('#mywfgTheylive').click();
      console.log('  Submitted OTP code.');

      const otpDeadline = Date.now() + 30000;
      let clearCount = 0;
      while (clearCount < 3) {
        if (Date.now() > otpDeadline) throw new Error('OTP submission did not redirect — code may be wrong');
        await page.waitForTimeout(800);
        clearCount = page.url().includes('macotp') ? 0 : clearCount + 1;
      }

      console.log('  Authorization complete.');
      await page.waitForLoadState('load', { timeout: 30000 });
      await page.waitForTimeout(2000);
    }

    console.log('Logged in. URL:', page.url());
    console.log('OTP_CLEAR_COMPLETE');
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
