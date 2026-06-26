import { describe, it, expect } from 'vitest'
import { contract, familySchema } from './ipc'

// Pure zod-contract checks for the family axis — no electron/main graph needed.

describe('familySchema', () => {
  it('accepts the two selection families and rejects anything else', () => {
    expect(familySchema.safeParse('gemma').success).toBe(true)
    expect(familySchema.safeParse('qwen').success).toBe(true)
    expect(familySchema.safeParse('experimental').success).toBe(false) // catalog-only, not a selection
    expect(familySchema.safeParse('llama').success).toBe(false)
  })
})

describe('contract — optional family on the model-pick methods', () => {
  it('chat.create / chat.send / chat.regenerate accept an optional family', () => {
    expect(contract['chat.create'].input.safeParse({ family: 'qwen' }).success).toBe(true)
    expect(contract['chat.create'].input.safeParse({}).success).toBe(true) // omittable
    expect(
      contract['chat.send'].input.safeParse({ conversationId: 'c', text: 'hi', family: 'gemma' })
        .success
    ).toBe(true)
    expect(
      contract['chat.regenerate'].input.safeParse({
        conversationId: 'c',
        messageId: 'm',
        family: 'qwen'
      }).success
    ).toBe(true)
    expect(
      contract['chat.create'].input.safeParse({ family: 'experimental' }).success
    ).toBe(false)
  })

  it('chat.update takes a nullable family (null = un-pin)', () => {
    expect(
      contract['chat.update'].input.safeParse({ conversationId: 'c', family: null }).success
    ).toBe(true)
    expect(
      contract['chat.update'].input.safeParse({ conversationId: 'c', family: 'gemma' }).success
    ).toBe(true)
  })

  it('agent.create / agent.prompt / pipeline.start carry an optional family', () => {
    expect(contract['agent.create'].input.safeParse({ directory: '/x', family: 'qwen' }).success).toBe(
      true
    )
    expect(
      contract['agent.prompt'].input.safeParse({ sessionId: 's', text: 'go', family: 'gemma' })
        .success
    ).toBe(true)
    expect(
      contract['pipeline.start'].input.safeParse({
        sessionId: 's',
        task: 't',
        options: { commit: true, docs: false, family: 'qwen' }
      }).success
    ).toBe(true)
  })

  it('models.setActiveFamily requires a valid family', () => {
    expect(contract['models.setActiveFamily'].input.safeParse({ family: 'gemma' }).success).toBe(true)
    expect(contract['models.setActiveFamily'].input.safeParse({ family: 'nope' }).success).toBe(false)
    expect(contract['models.setActiveFamily'].input.safeParse({}).success).toBe(false)
  })
})
