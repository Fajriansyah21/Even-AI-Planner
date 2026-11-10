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
  pushId: number;
  signal: AbortSignal;
  isAborted: () => boolean;
  isStale: () => boolean;
  guard?: CalendarOperationGuard;
}

export interface InFlightSessionRecord {
  sessionId: string;
  taskId: string;
  pushId: number;
  promise?: Promise<{ id: string; htmlLink?: string }>;
  remoteId?: string;
  htmlLink?: string;
  status: 'in_flight' | 'synced' | 'failed' | 'aborted';
}

export class CalendarOperationGuard {
  private connectOpId = 0;
  private syncOpId = 0;
  private pushOpId = 0;
  private activeSyncAbortController: AbortController | null = null;
  private activePushAbortController: AbortController | null = null;
  private inFlightSessions = new Map<string, InFlightSessionRecord>();

  /**
   * Initiates a new Connect operation.
   * Cancels any in-flight syncs or pushes, and returns a ticket for checking obsolescence.
   */
  public startConnect(): ConnectOperationTicket {
    const connectId = ++this.connectOpId;

    // Invalidate and abort ongoing syncs and pushes
    this.syncOpId++;
    this.pushOpId++;
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
    this.pushOpId++;
    this.abortActiveSync();
    this.abortActivePush();
    this.clearAllSessionStates();
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
    const pushId = ++this.pushOpId;

    return {
      pushId,
      signal: abortCtrl.signal,
      isAborted: () => abortCtrl.signal.aborted,
      isStale: () => this.pushOpId !== pushId,
      guard: this,
    };
  }

  /**
   * Builds composite key ensuring sessions with identical IDs across different tasks/users do not collide.
   */
  public static buildCompositeKey(sessionId: string, taskId?: string, userId?: string): string {
    const safeUser = userId && userId.trim() ? userId : 'all';
    const safeTask = taskId && taskId.trim() ? taskId : 'all';
    return `${safeUser}:${safeTask}:${sessionId}`;
  }

  /**
   * Registers a session currently being pushed by a specific push ticket.
   * If a promise is provided, concurrent operations for the same session can await or inspect it.
   */
  public registerInFlightSession(
    sessionId: string,
    taskId: string,
    pushId: number,
    promise?: Promise<{ id: string; htmlLink?: string }>,
    userId?: string
  ): void {
    const key = CalendarOperationGuard.buildCompositeKey(sessionId, taskId, userId);
    this.inFlightSessions.set(key, {
      sessionId,
      taskId,
      pushId,
      promise,
      status: 'in_flight',
    });
  }

  /**
   * Records that a session push successfully obtained a remote Google Calendar event ID.
   * Discards late completions if the operation has been superseded or disconnected.
   */
  public recordSessionSuccess(
    sessionId: string,
    taskId: string,
    remoteId: string,
    htmlLink?: string,
    userId?: string,
    pushId?: number
  ): void {
    // Late completion protection: If push is stale/superseded, reject writing to guard
    if (this.pushOpId > 0 && pushId !== undefined && !this.isPushActive(pushId)) {
      return;
    }

    const key = CalendarOperationGuard.buildCompositeKey(sessionId, taskId, userId);
    const existing = this.inFlightSessions.get(key);
    if (existing) {
      existing.remoteId = remoteId;
      existing.htmlLink = htmlLink;
      existing.status = 'synced';
    } else if (this.pushOpId === 0 || pushId === undefined || this.isPushActive(pushId)) {
      this.inFlightSessions.set(key, {
        sessionId,
        taskId,
        pushId: pushId ?? this.pushOpId,
        remoteId,
        htmlLink,
        status: 'synced',
      });
    }
  }

  /**
   * Records failure for a session push.
   */
  public recordSessionFailure(
    sessionId: string,
    taskId: string,
    userId?: string,
    pushId?: number
  ): void {
    if (this.pushOpId > 0 && pushId !== undefined && !this.isPushActive(pushId)) {
      return;
    }

    const key = CalendarOperationGuard.buildCompositeKey(sessionId, taskId, userId);
    const existing = this.inFlightSessions.get(key);
    if (existing && existing.status === 'in_flight') {
      existing.status = 'failed';
    }
  }

  /**
   * Gets the active in-flight or successfully synced session record using composite key.
   * Also supports fallback lookup by sessionId alone for backwards compatibility.
   */
  public getInFlightSession(
    sessionId: string,
    taskId?: string,
    userId?: string
  ): InFlightSessionRecord | undefined {
    const key = CalendarOperationGuard.buildCompositeKey(sessionId, taskId, userId);
    const exactMatch = this.inFlightSessions.get(key);
    if (exactMatch) return exactMatch;

    // Fallback: If taskId not supplied, search by sessionId
    if (!taskId) {
      for (const [k, record] of this.inFlightSessions.entries()) {
        if (record.sessionId === sessionId) {
          return record;
        }
      }
    }
    return undefined;
  }

  /**
   * Clears the in-flight state for a single session using composite key.
   */
  public clearSessionState(sessionId: string, taskId?: string, userId?: string): void {
    const key = CalendarOperationGuard.buildCompositeKey(sessionId, taskId, userId);
    this.inFlightSessions.delete(key);
    // Also remove any matching sessionId fallback
    for (const [k, record] of this.inFlightSessions.entries()) {
      if (record.sessionId === sessionId && (!taskId || record.taskId === taskId)) {
        this.inFlightSessions.delete(k);
      }
    }
  }

  /**
   * Clears all session states (e.g. on disconnect or hard reset).
   */
  public clearAllSessionStates(): void {
    this.inFlightSessions.clear();
  }

  /**
   * Checks if a push operation is still active.
   */
  public isPushActive(pushId: number): boolean {
    return this.pushOpId === pushId;
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
      currentPushId: this.pushOpId,
      hasActiveSyncController: Boolean(this.activeSyncAbortController),
      hasActivePushController: Boolean(this.activePushAbortController),
    };
  }
}
