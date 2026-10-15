/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ForgeAgent } from '../agent/forge.ts';
import { GitHubService } from '../services/github.ts';
import { ModelService } from '../services/model.ts';
import { TestRunnerService } from '../services/test-runner.ts';

/**
 * Centralized dependency injection container for ForgeAgent and services.
 * Implements a singleton pattern to manage service lifecycle and decouple
 * HTTP concerns from business logic.
 */
export class ServiceContainer {
  private static instance: ServiceContainer;
  private services: Map<string, any> = new Map();

  private constructor() {
    // Private constructor to enforce singleton pattern
  }

  /**
   * Returns the singleton instance of the ServiceContainer.
   */
  public static getInstance(): ServiceContainer {
    if (!ServiceContainer.instance) {
      ServiceContainer.instance = new ServiceContainer();
    }
    return ServiceContainer.instance;
  }

  /**
   * Registers a service instance in the container.
   * @param name - The unique name of the service.
   * @param instance - The service instance to register.
   */
  public register(name: string, instance: any): void {
    this.services.set(name, instance);
  }

  /**
   * Retrieves a service instance from the container.
   * If the service is not registered, it creates a new instance (lazy loading).
   * @param name - The name of the service to retrieve.
   * @param factory - Optional factory function to create the service if not registered.
   * @returns The service instance.
   */
  public get<T>(name: string, factory?: () => T): T {
    if (this.services.has(name)) {
      return this.services.get(name) as T;
    }

    if (factory) {
      const instance = factory();
      this.services.set(name, instance);
      return instance;
    }

    throw new Error(`Service '${name}' is not registered and no factory was provided.`);
  }

  /**
   * Convenience methods for specific services
   */
  public getForgeAgent(): ForgeAgent {
    return this.get<ForgeAgent>('ForgeAgent', () => new ForgeAgent());
  }

  public getGitHubService(token?: string): GitHubService {
    return this.get<GitHubService>('GitHubService', () => new GitHubService(token));
  }

  public getModelService(): ModelService {
    return this.get<ModelService>('ModelService', () => new ModelService());
  }

  public getTestRunnerService(): TestRunnerService {
    return this.get<TestRunnerService>('TestRunnerService', () => new TestRunnerService());
  }
}
