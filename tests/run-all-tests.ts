process.env.TZ = 'Asia/Jakarta';

import { runGoogleCalendarUnitTests } from './google-calendar.test';
import { runNightAndTimezoneTests } from './night-and-timezone-scheduling.test';
import { runRealGoogleCalendarIntegrationTest } from './real-google-integration.test';
import { runCalendarVerticalPositionTests } from './calendar-vertical-position.test';
import { runActivityHistoryAndStatusTests } from './activity-history-and-status.test';
import { runSchedulingBugsTests } from './scheduling-bugs-audit-and-fix.test';
import { runSchedulingReliabilityPatchTests } from './scheduling-reliability-patch.test';
import { runCriticalBugsValidationTests } from './critical-bugs-validation.test';
import { runMarkMissedCompletedTests } from './mark-missed-completed.test';
import { runAllAiSchedulerRegressionTests } from './ai-reasoning-and-scheduler-regression.test';
import { runAiSchedulerSuite } from './aiScheduler.test';
import { runLoadingUxTests } from './loadingUx.test';
import { runDeadlineAndSlotDiagnosticsTests } from './deadlineAndSlotDiagnostics.test';
import { runIndependentAuditSuite } from './independent-audit.test';

async function main() {
  console.log('================================================================');
  console.log('🚀 MENJALANKAN SELURUH PENGUJIAN OTOMATIS EVEN AI PLANNER 🚀');
  console.log('================================================================\n');

  try {
    // 1. Core Parser & Deterministic Scheduler Suite
    console.log('>>> [1/15] Parser & Scheduler Test Suite...');
    await import('./parser-scheduler.test');

    // 2. Night Scheduling & Asia/Jakarta Timezone Suite
    console.log('\n>>> [2/15] Night Scheduling & Timezone Suite...');
    await runNightAndTimezoneTests();

    // 3. Gemini Error Classification & Exponential Backoff Suite
    console.log('\n>>> [3/15] Gemini Error Handling & Resilience Suite...');
    await import('./gemini-error-handling.test');

    // 4. Auth Integrity & Zero Fake Login Suite
    console.log('\n>>> [4/15] Auth Integrity & Status Truth Suite...');
    await import('./auth-and-truth.test');

    // 5. Calendar Vertical Position & Scale Mapping Suite
    console.log('\n>>> [5/15] Calendar Vertical Position Mapping Suite...');
    runCalendarVerticalPositionTests();

    // 6. Activity History & Status Automation Suite
    console.log('\n>>> [6/15] Activity History & Automated Status Suite...');
    await runActivityHistoryAndStatusTests();

    // 7. Google Calendar Mock Read/Write Suite
    console.log('\n>>> [7/15] Google Calendar Mock API Suite...');
    await runGoogleCalendarUnitTests();

    // 8. Scheduling Bugs Audit & Multi-day Fix Suite
    console.log('\n>>> [8/15] Scheduling Bugs Audit & Multi-day Fix Suite...');
    await runSchedulingBugsTests();

    // 9. Scheduling Reliability Patch & Optimal Slot Suite
    console.log('\n>>> [9/15] Scheduling Reliability Patch & Optimal Slot Suite...');
    await runSchedulingReliabilityPatchTests();

    // 10. Critical Bugs & Regression Validation Suite
    console.log('\n>>> [10/15] Critical Bugs & Regression Validation Suite...');
    runCriticalBugsValidationTests();

    // 11. Mark Missed Activity as Completed Suite
    console.log('\n>>> [11/15] Mark Missed Task as Completed Suite...');
    runMarkMissedCompletedTests();

    // 12. Full AI Reasoning & Deterministic Scheduler Regression Suite
    console.log('\n>>> [12/15] Full AI Reasoning & Scheduler Regression Suite...');
    runAllAiSchedulerRegressionTests();

    // 13. Comprehensive AI Scheduler & Mock 2024 Reference Suite
    console.log('\n>>> [13/15] Comprehensive AI Scheduler Suite (tests/aiScheduler.test.ts)...');
    runAiSchedulerSuite();

    // 14. AI Analysis Loading UX & Honest Fallback Suite
    console.log('\n>>> [14/15] Loading UX, AI Analysis Stages & Fallback Transparency Suite...');
    await runLoadingUxTests();

    // 15. Deadline Bawaan Parser & Diagnosis Slot Penjadwalan Suite
    console.log('\n>>> [15/16] Deadline Bawaan Parser & Diagnosis Slot Penjadwalan Suite...');
    runDeadlineAndSlotDiagnosticsTests();

    // 16. Independent Audit Suite (Manual Override, Deadline Contradiction, Cross-Layer Validation)
    console.log('\n>>> [16/16] Independent Audit Suite (Manual Override & Contradictions)...');
    await runIndependentAuditSuite();

    // Real Google Calendar Integration (Opt-in Check)
    console.log('\n>>> [Opsi] Pengujian Integrasi Google Calendar Nyata...');
    await runRealGoogleCalendarIntegrationTest();

    console.log('\n================================================================');
    console.log('✨ SEMUA SUITE PENGUJIAN OTOMATIS BERHASIL DILALUI DENGAN GEMILANG! ✨');
    console.log('================================================================\n');
  } catch (err: any) {
    console.error('\n❌ KESALAHAN PADA SUITE PENGUJIAN:', err.message || err);
    process.exit(1);
  }
}

main();
