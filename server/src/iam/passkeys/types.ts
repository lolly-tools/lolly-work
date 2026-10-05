// SPDX-License-Identifier: MPL-2.0
export interface PasskeyRecord {
  id: string; userId: string; publicKey: string; counter: number; transports: string[];
  label: string; backedUp: boolean; deviceType: 'singleDevice' | 'multiDevice';
  createdAt: string; lastUsedAt?: string;
}
export interface PasskeyChallenge {
  id: string; nonceHash: string; challenge: string; kind: 'register' | 'authenticate';
  expiresAt: string; returnTo: string; userId?: string; epoch?: number;
}
export interface PasskeyStore {
  putPasskeyChallenge(record: PasskeyChallenge): Promise<boolean>;
  consumePasskeyChallenge(id: string, nonceHash: string): Promise<PasskeyChallenge | null>;
  listPasskeys(userId: string): Promise<PasskeyRecord[]>;
  getPasskey(id: string): Promise<PasskeyRecord | null>;
  registerPasskey(record: PasskeyRecord, epoch: number): Promise<boolean>;
  advancePasskey(expected: PasskeyRecord, nextCounter: number, backedUp: boolean, epoch: number): Promise<boolean>;
  removePasskey(id: string, userId: string, epoch: number): Promise<boolean>;
}
