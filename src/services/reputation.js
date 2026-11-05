// Puente al registro de reputación compartido (reputation.dotrino.com).
// Reusa el web-of-trust LOCAL del vault para ponderar (anti-sybil) y publica
// las atestaciones firmadas a la nube. Singleton, sobre el mismo Identity.

import { createVaultReputation } from '@dotrino/reputation'
import { getIdentity } from './identity'

/** @type {import('@dotrino/reputation').VaultReputation|null} */
let _rep = null

/**
 * La reputación sobre el vault, o null si no hay vault.
 * @returns {Promise<import('@dotrino/reputation').VaultReputation|null>}
 */
export async function getReputation () {
  if (_rep) return _rep
  const id = await getIdentity()
  if (!id) return null
  _rep = createVaultReputation(id)
  return _rep
}
