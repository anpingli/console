import * as _ from 'lodash';
import { K8sResourceKind, LabelSelector } from '@console/internal/module/k8s';
import { getRouteWebURL } from '@console/internal/components/routes';
import { KNATIVE_SERVING_LABEL } from '@console/knative-plugin';
import { sortBuilds } from '@console/internal/components/overview';
import {
  DeploymentModel,
  DaemonSetModel,
  StatefulSetModel,
  DeploymentConfigModel,
} from '@console/internal/models';
import { TopologyDataResources, ResourceProps, TopologyDataModel } from './topology-types';

export const podColor = {
  Running: '#0066CC',
  'Not Ready': '#519DE9',
  Warning: '#F0AB00',
  Empty: '#FFFFFF',
  Failed: '#CC0000',
  Pending: '#8BC1F7',
  Succceeded: '#519149',
  Terminating: '#002F5D',
  Unknown: '#A18FFF',
  'Scaled to 0': '#FFFFFF',
};

export const podStatus = Object.keys(podColor);

function numContainersReadyFilter(pod) {
  let numReady = 0;
  _.forEach(pod.status.containerStatuses, function(status) {
    if (status.ready) {
      numReady++;
    }
  });
  return numReady;
}

function isReady(pod) {
  const numReady = numContainersReadyFilter(pod);
  const total = _.size(pod.spec.containers);

  return numReady === total;
}

function isContainerFailedFilter(containerStatus) {
  return containerStatus.state.terminated && containerStatus.state.terminated.exitCode !== 0;
}

function isContainerLoopingFilter(containerStatus) {
  return (
    containerStatus.state.waiting && containerStatus.state.waiting.reason === 'CrashLoopBackOff'
  );
}

function isKnativeDeployment(dc: ResourceProps): boolean {
  return !!(dc.metadata && dc.metadata.labels && dc.metadata.labels[KNATIVE_SERVING_LABEL]);
}

function podWarnings(pod) {
  if (pod.status.phase === 'Running' && pod.status.containerStatuses) {
    return _.map(pod.status.containerStatuses, function(containerStatus) {
      if (!containerStatus.state) {
        return null;
      }

      if (isContainerFailedFilter(containerStatus)) {
        if (_.has(pod, ['metadata.deletionTimestamp'])) {
          return 'Failed';
        }
        return 'Warning';
      }
      if (isContainerLoopingFilter(containerStatus)) {
        return 'Failed';
      }
      return null;
    }).filter((x) => x);
  }
  return null;
}

export function getPodStatus(pod) {
  if (_.has(pod, ['metadata.deletionTimestamp'])) {
    return 'Terminating';
  }
  const warnings = podWarnings(pod);
  if (warnings !== null && warnings.length) {
    if (warnings.includes('Failed')) {
      return 'Failed';
    }
    return 'Warning';
  }
  if (pod.status.phase === 'Running' && !isReady(pod)) {
    return 'Not Ready';
  }
  return _.get(pod, 'status.phase', 'Unknown');
}

export class TransformTopologyData {
  private topologyData: TopologyDataModel = {
    graph: { nodes: [], edges: [], groups: [] },
    topology: {},
  };

  private deploymentKindMap = {
    deployments: {
      dcKind: DeploymentModel.kind,
      rcKind: 'ReplicaSet',
      rController: 'replicasets',
    },
    daemonSets: {
      dcKind: DaemonSetModel.kind,
      rcKind: 'ReplicaSet',
      rController: 'replicasets',
    },
    statefulSets: {
      dcKind: StatefulSetModel.kind,
      rcKind: 'ReplicaSet',
      rController: 'replicasets',
    },
    deploymentConfigs: {
      dcKind: DeploymentConfigModel.kind,
      rcKind: 'ReplicationController',
      rController: 'replicationControllers',
    },
  };

  private transformPods = (pods): K8sResourceKind[] => {
    return _.map(pods, (pod) =>
      _.merge(_.pick(pod, 'metadata', 'status', 'spec.containers'), {
        id: pod.metadata.uid,
        name: pod.metadata.name,
        kind: 'Pod',
      }),
    );
  };

  private selectorsByService;

  private allServices;

  constructor(public resources: TopologyDataResources, public application?: string) {
    if (this.resources.ksservices && this.resources.ksservices.data) {
      this.allServices = _.keyBy(
        [...this.resources.services.data, ...this.resources.ksservices.data],
        'metadata.name',
      );
    } else {
      this.allServices = _.keyBy(this.resources.services.data, 'metadata.name');
    }
    this.selectorsByService = this.getSelectorsByService();
  }

  /**
   * get the topology data
   */
  public getTopologyData() {
    return this.topologyData;
  }

  /**
   * get the route data
   */
  getRouteData(ksroute) {
    return !_.isEmpty(ksroute.status) ? ksroute.status.url : null;
  }

  /**
   * Tranforms the k8s resources objects into topology data
   * @param targetDeployment
   */
  public transformDataBy(targetDeployment = 'deployments'): TransformTopologyData {
    if (!this.deploymentKindMap[targetDeployment]) {
      throw new Error(`Invalid target deployment resource: (${targetDeployment})`);
    }
    if (_.isEmpty(this.resources[targetDeployment].data)) {
      return this;
    }
    const targetDeploymentsKind = this.deploymentKindMap[targetDeployment].dcKind;

    // filter data based on the active application
    const resourceData = this.filterBasedOnActiveApplication(this.resources[targetDeployment].data);

    _.forEach(resourceData, (deploymentConfig) => {
      deploymentConfig.kind = targetDeploymentsKind;
      const dcUID = _.get(deploymentConfig, 'metadata.uid');

      const replicationControllers = this.getReplicationControllers(
        deploymentConfig,
        targetDeployment,
      );
      const current = _.head(replicationControllers);
      const previous = _.nth(replicationControllers, 1);
      const currentPods = current
        ? this.transformPods(this.getPods(current, deploymentConfig))
        : [];
      const previousPods = previous
        ? this.transformPods(this.getPods(previous, deploymentConfig))
        : [];
      const service = this.getService(deploymentConfig);
      const route = this.getRoute(service);
      const buildConfigs = this.getBuildConfigs(deploymentConfig);
      // list of Knative resources
      const ksroute = this.getKSRoute(deploymentConfig);
      const configurations = this.getConfigurations(deploymentConfig);
      const revisions = this.getRevisions(deploymentConfig);
      // list of resources in the
      const nodeResources = [
        deploymentConfig,
        current,
        service,
        route,
        buildConfigs,
        ksroute,
        configurations,
        revisions,
      ];
      // populate the graph Data
      this.createGraphData(deploymentConfig);
      // add the lookup object
      const deploymentsLabels = _.get(deploymentConfig, 'metadata.labels') || {};
      const deploymentsAnnotations = _.get(deploymentConfig, 'metadata.annotations') || {};
      this.topologyData.topology[dcUID] = {
        id: dcUID,
        name:
          _.get(deploymentConfig, 'metadata.name') ||
          deploymentsLabels['app.kubernetes.io/instance'],

        type: 'workload',
        resources: _.map(nodeResources, (resource) => {
          return {
            ...resource,
            name: _.get(resource, 'metadata.name'),
          };
        }),
        pods: [...currentPods, ...previousPods],
        data: {
          url: !_.isEmpty(route.spec) ? getRouteWebURL(route) : this.getRouteData(ksroute),
          kind: targetDeploymentsKind,
          editUrl:
            deploymentsAnnotations['app.openshift.io/edit-url'] ||
            deploymentsAnnotations['app.openshift.io/vcs-uri'],
          builderImage: deploymentsLabels['app.kubernetes.io/name'],
          isKnativeResource: this.isKnativeServing(deploymentConfig, 'metadata.labels'),
          donutStatus: {
            pods: currentPods,
          },
        },
      };
    });
    return this;
  }

  private getSelectorsByService() {
    let allServices = _.keyBy(this.resources.services.data, 'metadata.name');
    if (this.resources.ksservices && this.resources.ksservices.data) {
      allServices = _.keyBy(
        [...this.resources.services.data, ...this.resources.ksservices.data],
        'metadata.name',
      );
    }
    const selectorsByService = _.mapValues(allServices, (service) => {
      return new LabelSelector(service.spec.selector);
    });
    return selectorsByService;
  }

  /**
   * filter data based on the active application
   * @param data
   */
  private filterBasedOnActiveApplication(data) {
    const PART_OF = 'app.kubernetes.io/part-of';
    if (!this.application) {
      return data;
    }
    return data.filter((dc) => {
      return _.get(dc, ['metadata', 'labels', PART_OF]) === this.application;
    });
  }

  /**
   * get the route information from the service
   * @param service
   */
  private getRoute(service: ResourceProps): ResourceProps {
    // get the route
    const route = {
      kind: 'Route',
      metadata: {},
      status: {},
      spec: {},
    };
    _.forEach(this.resources.routes.data, (routeConfig) => {
      if (_.get(service, 'metadata.name') === _.get(routeConfig, 'spec.to.name')) {
        _.merge(route, routeConfig);
      }
    });
    return route;
  }

  /**
   * get the knative route information from the service
   * @param service
   */
  private getKSRoute(dc: ResourceProps): ResourceProps {
    const route = {
      kind: 'Route',
      metadata: {},
      status: {},
      spec: {},
    };
    const { ksroutes } = this.resources;
    if (isKnativeDeployment(dc)) {
      _.forEach(ksroutes && ksroutes.data, (routeConfig) => {
        if (dc.metadata.labels[KNATIVE_SERVING_LABEL] === _.get(routeConfig, 'metadata.name')) {
          _.merge(route, routeConfig);
        }
      });
    }
    return route;
  }

  /**
   * get the configuration information from the service
   * @param replicationController
   */
  private getConfigurations(dc: ResourceProps): ResourceProps {
    const configuration = {
      kind: 'Configuration',
      metadata: {},
      status: {},
      spec: {},
    };
    const { configurations } = this.resources;
    if (isKnativeDeployment(dc)) {
      _.forEach(configurations && configurations.data, (config) => {
        if (dc.metadata.labels[KNATIVE_SERVING_LABEL] === _.get(config, 'metadata.name')) {
          _.merge(configuration, config);
        }
      });
    }
    return configuration;
  }

  /**
   * get the revision information from the service
   * @param replicationController
   */
  private getRevisions(dc: ResourceProps): ResourceProps {
    const revision = {
      kind: 'Revision',
      metadata: {},
      status: {},
      spec: {},
    };
    const { revisions } = this.resources;
    if (isKnativeDeployment(dc)) {
      _.forEach(revisions && revisions.data, (revisionConfig) => {
        if (dc.metadata.ownerReferences[0].uid === revisionConfig.metadata.uid) {
          _.merge(revision, revisionConfig);
        }
      });
    }
    return revision;
  }

  private getBuildConfigs(
    deploymentConfig: ResourceProps,
  ): ResourceProps & { builds: K8sResourceKind[] } {
    const buildConfig = {
      kind: 'BuildConfig',
      builds: [] as K8sResourceKind[],
      metadata: {},
      status: {},
      spec: {},
    };

    const bconfig = _.find(this.resources.buildconfigs.data, [
      'metadata.labels["app.kubernetes.io/instance"]',
      _.get(deploymentConfig, 'metadata.labels["app.kubernetes.io/instance"]'),
    ]);
    if (bconfig) {
      const bc = _.merge(buildConfig, bconfig);
      const builds = sortBuilds(this.getBuilds(bc));
      return { ...bc, builds };
    }
    return buildConfig;
  }

  private getBuilds({ metadata: { uid } }: ResourceProps): ResourceProps[] {
    const builds = {
      kind: 'Builds',
      metadata: {},
      status: {},
      spec: {},
    };
    const bs = this.resources.builds.data.filter(({ metadata: { ownerReferences } }) => {
      return _.some(ownerReferences, {
        uid,
        controller: true,
      });
    });
    return bs ? _.map(bs, (build) => _.extend({}, build, { kind: 'Builds' })) : [builds];
  }

  /**
   * fetches the service from the deploymentconfig
   * @param deploymentConfig
   */
  private getService(deploymentConfig: ResourceProps): ResourceProps {
    const service = {
      kind: 'Service',
      metadata: {},
      status: {},
      spec: {},
    };
    const configTemplate = _.get(deploymentConfig, 'spec.template');
    _.each(this.selectorsByService, (selector, serviceName) => {
      if (selector.matches(configTemplate)) {
        _.merge(service, this.allServices[serviceName]);
      }
    });
    return service;
  }

  /**
   * check if config is knative serving resource.
   * @param configRes
   * @param properties
   */
  private isKnativeServing(configRes: ResourceProps, properties: string): boolean {
    const deploymentsLabels = _.get(configRes, properties) || {};
    return !!deploymentsLabels['serving.knative.dev/configuration'];
  }

  /**
   * check if the deployment/deploymentconfig is idled.
   * @param deploymentConfig
   */
  private isIdled(deploymentConfig: ResourceProps): boolean {
    return !!_.get(
      deploymentConfig,
      "metadata.annotations['idling.alpha.openshift.io/idled-at']",
      false,
    );
  }

  /**
   * Get all the pods from a replication controller or a replicaset.
   * @param replicationController
   */
  private getPods(replicationController: ResourceProps, deploymentConfig: ResourceProps) {
    const deploymentCondition = {
      uid: _.get(replicationController, 'metadata.uid'),
      controller: true,
    };
    const dcCondition = {
      uid: _.get(deploymentConfig, 'metadata.uid'),
    };
    const condition =
      deploymentConfig.kind === DaemonSetModel.kind ||
      deploymentConfig.kind === StatefulSetModel.kind
        ? dcCondition
        : deploymentCondition;
    const dcPodsData = _.filter(this.resources.pods.data, (pod) => {
      return _.some(_.get(pod, 'metadata.ownerReferences'), condition);
    });
    if (
      dcPodsData &&
      !dcPodsData.length &&
      (this.isKnativeServing(replicationController, 'metadata.labels') ||
        this.isIdled(deploymentConfig))
    ) {
      return [
        {
          ..._.pick(replicationController, 'metadata', 'status', 'spec'),
          status: { phase: 'Scaled to 0' },
        },
      ];
    }
    return dcPodsData;
  }

  /**
   * fetches all the replication controllers from the deployment
   * @param deploymentConfig
   * @param targetDeployment 'deployments' || 'deploymentConfigs'
   */
  private getReplicationControllers(
    deploymentConfig: ResourceProps,
    targetDeployment: string,
  ): ResourceProps[] {
    // Get the current replication controller or replicaset
    const targetReplicationControllersKind = this.deploymentKindMap[targetDeployment].rcKind;
    const replicationControllers = this.deploymentKindMap[targetDeployment].rController;
    const dcUID = _.get(deploymentConfig, 'metadata.uid');

    const rControllers = _.filter(
      this.resources[replicationControllers].data,
      (replicationController) => {
        return _.some(_.get(replicationController, 'metadata.ownerReferences'), {
          uid: dcUID,
          controller: true,
        });
      },
    );
    const sortedControllers = this.sortByDeploymentVersion(rControllers, true);
    return _.size(sortedControllers)
      ? _.map(sortedControllers, (nextController) =>
          _.merge(nextController, {
            kind: targetReplicationControllersKind,
          }),
        )
      : ([{ kind: targetReplicationControllersKind }] as ResourceProps[]);
  }

  /**
   * create graph data from the deploymentconfig.
   * @param deploymentConfig
   */
  private createGraphData(deploymentConfig) {
    // Current Node data
    const { metadata } = deploymentConfig;
    const currentNode = {
      id: metadata.uid,
      type: 'workload',
      name: (metadata.labels && metadata.labels['app.openshift.io/instance']) || metadata.name,
    };

    if (!_.some(this.topologyData.graph.nodes, { id: currentNode.id })) {
      // add the node to graph
      this.topologyData.graph.nodes.push(currentNode);
      const labels = _.get(deploymentConfig, 'metadata.labels');
      const annotations = _.get(deploymentConfig, 'metadata.annotations');
      let edges = [];
      const totalDeployments = _.cloneDeep(
        _.concat(this.resources.deploymentConfigs.data, this.resources.deployments.data),
      );
      // find and add the edges for a node
      if (_.has(annotations, ['app.openshift.io/connects-to'])) {
        try {
          edges = JSON.parse(annotations['app.openshift.io/connects-to']);
        } catch (e) {
          // connects-to annotation should hold a JSON string value but failed to parse
          // treat value as a comma separated list of strings
          edges = annotations['app.openshift.io/connects-to'].split(',').map((v) => v.trim());
        }
        _.map(edges, (edge) => {
          // handles multiple edges
          const targetNode = _.get(
            _.find(totalDeployments, ['metadata.labels["app.kubernetes.io/instance"]', edge]),
            'metadata.uid',
          );
          if (targetNode) {
            this.topologyData.graph.edges.push({
              id: `${currentNode.id}_${targetNode}`,
              type: 'connects-to',
              source: currentNode.id,
              target: targetNode,
            });
          }
        });
      }

      _.forEach(labels, (label, key) => {
        if (key !== 'app.kubernetes.io/part-of') {
          return;
        }
        // find and add the groups
        const groupExists = _.some(this.topologyData.graph.groups, {
          name: label,
        });
        if (!groupExists) {
          this.topologyData.graph.groups.push({
            id: `group:${label}`,
            name: label,
            nodes: [currentNode.id],
          });
        } else {
          const gIndex = _.findIndex(this.topologyData.graph.groups, { name: label });
          this.topologyData.graph.groups[gIndex].nodes.push(currentNode.id);
        }
      });
    }
  }

  /**
   * sort the deployement version
   */
  private sortByDeploymentVersion = (
    replicationControllers: ResourceProps[],
    descending: boolean,
  ) => {
    const version = 'openshift.io/deployment-config.latest-version';
    const compareDeployments = (left, right) => {
      const leftVersion = parseInt(_.get(left, version), 10);
      const rightVersion = parseInt(_.get(right, version), 10);

      // Fall back to sorting by name if right Name no deployment versions.
      let leftName: string;
      let rightName: string;
      if (!_.isFinite(leftVersion) && !_.isFinite(rightVersion)) {
        leftName = _.get(left, 'metadata.name', '');
        rightName = _.get(right, 'metadata.name', '');
        if (descending) {
          return rightName.localeCompare(leftName);
        }
        return leftName.localeCompare(rightName);
      }

      if (!leftVersion) {
        return descending ? 1 : -1;
      }

      if (!rightVersion) {
        return descending ? -1 : 1;
      }

      if (descending) {
        return rightVersion - leftVersion;
      }
      return leftVersion - rightVersion;
    };

    return _.toArray(replicationControllers).sort(compareDeployments);
  };
}
