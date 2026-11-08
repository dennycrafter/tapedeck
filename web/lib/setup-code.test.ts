import { describe, expect, it } from 'vitest'
import { decodeSetupCode, encodeSetupCode } from './setup-code'

// The same code agent/tests/test_setup_code.py decodes: both sides agree.
const TOKEN = 'ab'.repeat(32)
const SAMPLE =
  'tapedeck1:eyJ1IjoiaHR0cHM6Ly9teS10YXBlZGVjay52ZXJjZWwuYXBwIiwidCI6ImFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWIifQ'

describe('setup code', () => {
  it('packs the app address and agent token into one line the PC reads', () => {
    expect(encodeSetupCode({ appUrl: 'https://my-tapedeck.vercel.app', agentToken: TOKEN })).toBe(SAMPLE)
    expect(decodeSetupCode(`  ${SAMPLE}\n`)).toEqual({ appUrl: 'https://my-tapedeck.vercel.app', agentToken: TOKEN })
  })

  it('drops a trailing slash and refuses anything else', () => {
    expect(decodeSetupCode(encodeSetupCode({ appUrl: 'https://x.vercel.app/', agentToken: 't' }))).toEqual({
      appUrl: 'https://x.vercel.app',
      agentToken: 't',
    })
    expect(decodeSetupCode('hello')).toBeNull()
    expect(decodeSetupCode('tapedeck1:!!!')).toBeNull()
    expect(decodeSetupCode(`tapedeck1:${Buffer.from('{"u":"ftp://x","t":"t"}').toString('base64url')}`)).toBeNull()
    expect(decodeSetupCode(`tapedeck1:${Buffer.from('{"u":"https://x","t":""}').toString('base64url')}`)).toBeNull()
  })
})
