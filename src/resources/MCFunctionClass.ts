import chalk from 'chalk'
import { CONFLICT_STRATEGIES } from '@/env'
import { isPromise } from '@/utils'

import type { BASIC_CONFLICT_STRATEGIES } from '@/generalTypes'
import type { Either } from '@/utils'
import type { TimeArgument } from '@arguments'
import type { Datapack } from '@datapack'
import type { MCFunctionInstance } from '@datapack/Datapack'
import type { FunctionResource, ResourceConflictStrategy, ResourcePath } from '@datapack/resourcesTree'
import type { TagInstance } from './Tag'

export type MCFunctionOptions = {
  /**
   * If true, then the function will only be created if it is called from another function.
   */
  lazy?: boolean

  /**
   * Whether to activate debugging features for the function.
   *
   * For the moment, it only adds some comments detailling what each function options & arguments are.
   *
   * It defaults to `true` if the environment variable NODE_ENV is set to `development`, else it defaults to `false`
   */
  debug?: boolean

  /**
   * Whether the function should run when the datapack loads.
   *
   * Defaults to `true` if `runEvery` is specified, else `false`.
   */
  runOnLoad?: boolean

  /**
   * What to do if another MCFunction has the same name.
   *
   * - `throw`: Throw an error.
   * - `replace`: Replace silently the old MCFunction with the new one.
   * - `ignore`: Keep silently the old MCFunction, discarding the new one.
   * - `warn`: Logs a warning to the console.
   * - `append`: Append the commands of the new MCFunction on the bottom of the new one.
   * - `prepend`: Prepend the commands of the new MCFunction on the top of the new one.
   */
  onConflict?: BASIC_CONFLICT_STRATEGIES | 'append' | 'prepend'

  /**
   * The function tags to put this function in.
   */
  tags?: readonly (string | TagInstance<'functions'>)[]
} & Either<{
  /**
   * @deprecated Use runEveryTick instead.
   */
  runEachTick?: boolean
  /**
   * Whether the function should run each tick.
   */
  runEveryTick?: boolean
}, {
  /**
   * @deprecated Use runEvery instead.
   */
  runEach?: TimeArgument

  /**
   * If specified, the function will run every given time.
   *
   * If `runOnLoad` is unspecified or `true`, then it will run on load too.
   *
   * If `runOnLoad` is `false`, you will have to manually start it.
   *
   * You can stop the automatic scheduling by running `theFunction.clearSchedule()`.
   *
   * @example
   *
   * // Run every 5 ticks, including on data pack load.
   * {
   *   runEvery: 5,
   * }
   *
   * // Run every 5 ticks, but wait 5 ticks before data pack loads for 1st execution.
   * {
   *   runEvery: 5,
   *   runOnLoad: false,
   * }
   *
   * // Run every 8 seconds
   * {
   *   runEvery: '8s'
   * }
   */
  runEvery?: TimeArgument
}
>

export class MCFunctionClass<R extends void | Promise<void> = void | Promise<void>> {
  name: string

  path: ResourcePath

  options: MCFunctionOptions

  alreadyInitialized: boolean

  datapack: Datapack

  onConflict: NonNullable<MCFunctionOptions['onConflict']>

  callback: () => R

  constructor(datapack: Datapack, name: string, callback: (this: MCFunctionInstance) => R, options?: MCFunctionOptions) {
    options = options ?? {}
    this.options = { lazy: false, debug: process.env.NODE_ENV === 'development', ...options }

    this.alreadyInitialized = false
    this.callback = callback
    this.datapack = datapack

    this.onConflict = options.onConflict ?? CONFLICT_STRATEGIES.MCFUNCTION

    // We "reserve" the folder by creating an empty folder there. It can be later changed to be a resource.
    const functionsPaths = datapack.getResourcePath(name)

    this.name = functionsPaths.fullName
    this.path = functionsPaths.fullPathWithNamespace
  }

  private generateResource(strategy: ResourceConflictStrategy<'functions'>): FunctionResource & { isResource: true } {
    const resource = this.datapack.resources.addResource('functions', {
      children: new Map(), isResource: true, path: this.path, commands: [],
    }, strategy)

    return resource
  }

  /**
   * Call the actual function overload. Returns different informations about it.
   */
  generate = (): R => {
    const { commandsRoot } = this.datapack

    if (this.alreadyInitialized) {
      return undefined as any
    }

    // Get the given tags
    let tags = this.options.tags ?? []

    // If it should run each tick, add it to the tick.json function
    const opts = this.options as any
    const runEveryDelay = opts.runEvery ?? opts.runEach

    if (runEveryDelay !== undefined) {
      if (typeof runEveryDelay === 'number' && runEveryDelay < 0) { throw new Error(`\`runEvery\` argument must be greater than 0, got ${runEveryDelay}`) }

      if (this.options.runOnLoad !== false) {
        // If run on load, call it directly
        tags = [...tags, 'minecraft:load']
      }
    } else {
      // If runEachTick is specified, add to minecraft:tick
      if (opts.runEveryTick ?? opts.runEachTick) {
        tags = [...tags, 'minecraft:tick']
      }

      // Idem for load
      if (this.options.runOnLoad) {
        tags = [...tags, 'minecraft:load']
      }
    }

    const warning = chalk.hex('#FFA500')
    if (opts.runEachTick !== undefined) {
      console.warn(warning('The `runEachTick` MCFunction option is deprecated, use `runEveryTick` instead.'))
    }

    if (opts.runEach !== undefined) {
      console.warn(warning('The `runEach` MCFunction option is deprecated, use `runEvery` instead.'))
    }

    for (const tag of tags) {
      if (typeof tag === 'string') {
        this.datapack.addFunctionToTag(this.name, tag)
      } else {
        tag.values.push(this.name)
      }
    }

    const previousFunction = this.datapack.currentFunction

    // Choose the conflict strategy
    let onConflict: ResourceConflictStrategy<'functions'>
    let previousResource: FunctionResource & { isResource: true }

    if (this.onConflict === 'append' || this.onConflict === 'prepend') {
      onConflict = (oldFunc, newFunc) => {
        previousResource = oldFunc
        newFunc.children = oldFunc.children
        return newFunc
      }
    } else {
      onConflict = this.onConflict
    }

    const resource = this.generateResource(onConflict)
    this.datapack.currentFunction = resource

    const result = this.callback()

    // If the command was scheduled to run each n ticks, add the /schedule command
    if (runEveryDelay) {
      this.datapack.commandsRoot.schedule.function(this.name, runEveryDelay, 'append')
    }

    const afterCall = () => {
      // If there is an unfinished command, register it
      commandsRoot.register(true)

      if (this.onConflict === 'append') {
        resource.commands = [...(previousResource?.commands ?? []), ...resource.commands]
      }
      if (this.onConflict === 'prepend' && previousResource) {
        resource.commands = [...resource.commands, ...(previousResource?.commands ?? [])]
      }

      // Then back to the previous one
      this.datapack.currentFunction = previousFunction
    }

    this.alreadyInitialized = true

    if (isPromise(result)) {
      return result.then(afterCall) as any
    }

    return afterCall() as any
  }

  call = () => {
    this.datapack.commandsRoot.functionCmd(this.name)
  }

  private scheduleFunction = (delay: TimeArgument, type?: 'replace' | 'append') => {
    this.datapack.commandsRoot.schedule.function(this.name, delay, type)
  }

  private clearSchedule = () => {
    this.datapack.commandsRoot.schedule.clear(this.name)
  }

  schedule = (() => {
    const scheduleFunction = this.scheduleFunction as ((delay: TimeArgument, type?: 'replace' | 'append') => void) & { clear: () => void }

    scheduleFunction.clear = this.clearSchedule
    return scheduleFunction
  })()

  toString = () => this.name

  toJSON = this.toString
}
