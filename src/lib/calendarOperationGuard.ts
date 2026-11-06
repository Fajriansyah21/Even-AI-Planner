/**
 * Calendar Operation Guard
 *
 * Centralized sequencing and concurrency guard for Google Calendar operations:
 * - OAuth Connect sequencing (prevents stale popup resurrection and token overwriting)
 * - Calendar Sync request sequencing and AbortController lifecycle
 * - Calendar Event Push AbortController lifecycle
 * - State transition integrity protection
 */

export interface ConnectOperationTicket {
  connectId: number;
  isStale: () => boolean;
}

export interface SyncOperationTicket {
  syncId: number;
  signal: AbortSignal;
  isStale: () => boolean;
}

export interface PushOperationTicket {
  signal: AbortSignal;
  isAborted: () => boolean;
}

export class CalendarOperationGuard {
  private connectOpId = 0;
  private syncOpId = 0;
  private activeSyncAbortController: AbortController | null = null;
  private activePushAbortController: AbortController | null = null;

  /**
   * Initiates a new Connect operation.
   * Cancels any in-flight syncs or pushes, and returns a ticket for checking obsolescence.
   */
  public startConnect(): ConnectOperationTicket {
    const connectId = ++this.connectOpId;

    // Invalidate and abort ongoing syncs
    this.syncOpId++;
    this.abortActiveSync();
    this.abortActivePush();

    return {
      connectId,
      isStale: () => this.connectOpId !== connectId,
    };
  }

  /**
   * Checks if a connect operation is still the active, newest operation.
   */
  public isConnectActive(connectId: number): boolean {
    return this.connectOpId === connectId;
  }

  /**
   * Disconnects Google Calendar:
   * Invalidates all in-flight connect operations, syncs, and pushes.
   */
  public disconnect(): void {
    this.connectOpId++;
    this.syncOpId++;
    this.abortActiveSync();
    this.abortActivePush();
  }

  /**
   * Initiates a new Sync operation.
   * Aborts any previous sync in flight and returns a ticket with AbortSignal.
   */
  public startSync(): SyncOperationTicket {
    this.abortActiveSync();
    const abortCtrl = new AbortController();
    this.activeSyncAbortController = abortCtrl;
    const syncId = ++this.syncOpId;

    return {
      syncId,
      signal: abortCtrl.signal,
      isStale: () => this.syncOpId !== syncId,
    };
  }

  /**
   * Checks if a sync operation is still active.
   */
  public isSyncActive(syncId: number): boolean {
    return this.syncOpId === syncId;
  }

  /**
   * Initiates a new Push operation (saving sessions to Google Calendar).
   * Aborts any previous push in flight.
   */
  public startPush(): PushOperationTicket {
    this.abortActivePush();
    const abortCtrl = new AbortController();
    this.activePushAbortController = abortCtrl;

    return {
      signal: abortCtrl.signal,
      isAborted: () => abortCtrl.signal.aborted,
    };
  }

  /**
   * Aborts the active sync operation if one is running.
   */
  public abortActiveSync(): void {
    if (this.activeSyncAbortController) {
      this.activeSyncAbortController.abort();
      this.activeSyncAbortController = null;
    }
  }

  /**
   * Aborts the active push operation if one is running.
   */
  public abortActivePush(): void {
    if (this.activePushAbortController) {
      this.activePushAbortController.abort();
      this.activePushAbortController = null;
    }
  }

  /**
   * Returns current internal operation IDs for diagnostic inspection.
   */
  public getDiagnosticState() {
    return {
      currentConnectId: this.connectOpId,
      currentSyncId: this.syncOpId,
      hasActiveSyncController: Boolean(this.activeSyncAbortController),
      hasActivePushController: Boolean(this.activePushAbortController),
    };
  }
}
