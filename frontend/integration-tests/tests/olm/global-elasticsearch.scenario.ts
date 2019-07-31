import { browser, $, element, ExpectedConditions as until, by } from 'protractor';
import { safeDump, safeLoad } from 'js-yaml';
import * as _ from 'lodash';
import { execSync } from 'child_process';

import { appHost, testName, checkLogs, checkErrors } from '../../protractor.conf';
import * as crudView from '../../views/crud.view';
import * as catalogView from '../../views/catalog.view';
import * as catalogPageView from '../../views/catalog-page.view';
import * as operatorHubView from '../../views/operator-hub.view';
import * as sidenavView from '../../views/sidenav.view';
import * as yamlView from '../../views/yaml.view';

describe('Deploy an `AllNamespaces` Elasticsearch Operator', () => {
  const deleteRecoveryTime = 60000;
  const elasticsearchOperatorName = 'elasticsearch-operator';
  const testLabel = 'automatedTestName';
  #const elasticsearchCluster= `${testName}-elasticsearch-operator`;
  const testName='anlitest'
  const elasticsearchCluster= 'openshift-logging';

  const catalogNamespace = _.get(browser.params, 'globalCatalogNamespace', 'openshift-marketplace');
  const globalOperatorsNamespace = _.get(browser.params, 'globalOperatorsNamespace', 'openshift-operators');


  const packageManifest = {
    "apiVersion": "packages.operators.coreos.com/v1",
    "kind": "PackageManifest",
    "metadata": {
        "labels": {
            "catalog": "redhat-operators",
            "catalog-namespace": "openshift-marketplace",
            "olm-visibility": "hidden",
            "openshift-marketplace": "true",
            "opsrc-datastore": "true",
            "opsrc-owner-name": "redhat-operators",
            "opsrc-owner-namespace": "openshift-marketplace",
            "opsrc-provider": "redhat",
            "provider": "Red Hat, Inc",
            "provider-url": ""
        },
        "name": "elasticsearch-operator",
        "namespace": "openshift-marketplace",
    },
    "spec": {}
  };

  beforeAll(async() => {
    await new Promise(resolve => (function checkForPackages() {
      const output = execSync(`kubectl get packagemanifest elasticsearch-operator -n ${catalogNamespace} -o json`);
      if (JSON.parse(output.toString('utf-8')).items.find(pkg => pkg.status.packageName === packageManifest.metadata.name)) {
        return resolve();
      }
      setTimeout(checkForPackages, 2000);
    })());

    await browser.get(`${appHost}/status/ns/${globalOperatorsNamespace}`);
    await browser.wait(until.presenceOf(sidenavView.navSectionFor('Operators')));
    await sidenavView.clickNavLink(['Operators', 'OperatorHub']);
    await crudView.isLoaded();
  });

  afterAll(() => {
    [
      `kubectl delete subscription -n ${globalOperatorsNamespace} elasticsearch-operator`,
      `kubectl delete clusterserviceversion -n ${globalOperatorsNamespace} elasticsearch-operator.v0.0.1`,
    ].forEach(cmd => _.attempt(() => execSync(cmd)));
  });

  afterEach(() => {
    checkLogs();
    checkErrors();
  });

  it('displays subscription creation form for selected Operator', async() => {
    await catalogView.categoryTabs.get(0).click();
    await catalogPageView.clickFilterCheckbox('providerType-red-hat');
    await catalogPageView.catalogTileFor('Elasticsearch Operator').click();
    await browser.wait(until.visibilityOf(operatorHubView.operatorModal));
    await operatorHubView.operatorModalInstallBtn.click();
    await operatorHubView.createSubscriptionFormLoaded();

    expect(operatorHubView.createSubscriptionFormName.getText()).toEqual('Elasticsearch Operator');
  });

  it('selects all namespaces for Operator subscription', async() => {
    await browser.wait(until.visibilityOf(operatorHubView.createSubscriptionFormInstallMode));
    await operatorHubView.allNamespacesInstallMode.click();

    expect(operatorHubView.createSubscriptionError.isPresent()).toBe(false);
    expect(operatorHubView.createSubscriptionFormBtn.getAttribute('disabled')).toEqual(null);
  });

  it('displays Operator as subscribed in OperatorHub', async() => {
    await operatorHubView.createSubscriptionFormBtn.click();
    await crudView.isLoaded();
    await browser.get(`${appHost}/operatorhub/ns/${testName}`);
    await crudView.isLoaded();
    await catalogPageView.clickFilterCheckbox('installState-installed');

    expect(catalogPageView.catalogTileFor('Elasticsearch Operator').isDis`played()).toBe(true);
  });

  it(`displays Operator in "Cluster Service Versions" view for "${testName}" namespace`, async() => {
    await catalogPageView.catalogTileFor('Elasticsearch Operator').click();
    await operatorHubView.operatorModalIsLoaded();
    await operatorHubView.viewInstalledOperator();
    await crudView.isLoaded();

    await browser.wait(until.visibilityOf(crudView.rowForOperator('')), 30000);
  });

  it('creates Elasticsearch Operator `Deployment`', async() => {
    await browser.get(`${appHost}/k8s/all-namespaces/deployments`);
    await crudView.isLoaded();
    await crudView.filterForName(elasticsearchOperatorName);
    await browser.wait(until.textToBePresentInElement(crudView.rowForName(elasticsearchOperatorName).$('a[title=pods]'), '1 of 1 pods'), 100000);

    expect(crudView.rowForName(elasticsearchOperatorName).isDisplayed()).toBe(true);
  });

  xit('recreates elasticsearch operator  `Deployment` if manually deleted', async() => {
    await crudView.deleteRow('Deployment')(elasticsearchOperatorName);
    await browser.wait(until.textToBePresentInElement(crudView.rowForName(elasticsearchOperatorName).$('a[title=pods]'), '0 of 1 pods'));
    await browser.wait(until.textToBePresentInElement(crudView.rowForName(elasticsearchOperatorName).$('a[title=pods]'), '1 of 1 pods'));

    expect(crudView.rowForName(elasticsearchOperatorName).isDisplayed()).toBe(true);
  }, deleteRecoveryTime);

  it('displays metadata about Elasticsearch Operator in the "Overview" section', async() => {
    await browser.get(`${appHost}/k8s/ns/${testName}/clusterserviceversions`);
    await crudView.isLoaded();
    await crudView.rowForOperator('').$('.co-clusterserviceversion-logo').click();
    await browser.wait(until.presenceOf($('.loading-box__loaded')), 5000);

    expect($('.co-m-pane__details').isDisplayed()).toBe(true);
  });

  it('displays empty message in the "Elasticsearch Operator" section', async() => {
    await element(by.linkText('Elasticsearch Operator')).click();
    await crudView.isLoaded();

    expect(crudView.statusMessageTitle.getText()).toEqual('No Operands Found');
    expect(crudView.statusMessageDetail.getText()).toEqual('Operands are declarative components used to define the behavior of the application.');
  });

  it('displays YAML editor for creating a new `Elasticsearch` instance', async() => {
    await browser.wait(until.visibilityOf(element(by.buttonText('Create Instance'))));
    await element(by.buttonText('Create Instance')).click();
    await yamlView.isLoaded();

    const content = await yamlView.getEditorContent();
    const newContent = _.defaultsDeep({}, {metadata: {labels: {[testLabel]: testName}}}, safeLoad(content));
    await yamlView.setEditorContent(safeDump(newContent));

    expect($('.co-create-operand__header').getText()).toContain('Create Instance');
  });

  it('displays new `ElasticsearchCluster` that was created from YAML editor', async() => {
    await $('#save-changes').click();
    await crudView.isLoaded();
    await browser.wait(until.visibilityOf(crudView.rowForName(elasticsearchCluster)));

    expect(crudView.rowForName(elasticsearchCluster).getText()).toContain('ElasticsearchCluster');
  });

  it('displays metadata about the created `ElasticsearchCluster` in its "Overview" section', async() => {
    await crudView.rowForName(elasticsearchCluster).element(by.linkText(elasticsearchCluster)).click();
    await browser.wait(until.presenceOf($('.loading-box__loaded')), 5000);

    expect($('.co-operand-details__section--info').isDisplayed()).toBe(true);
  });

  it('displays the raw YAML for the `ElasticsearchCluster`', async() => {
    await element(by.linkText('YAML')).click();
    await browser.wait(until.presenceOf($('.yaml-editor__buttons')));
    await $('.yaml-editor__buttons').element(by.buttonText('Save')).click();
    await browser.wait(until.visibilityOf(crudView.successMessage), 2000);

    expect(crudView.successMessage.getText()).toContain(`${elasticsearchCluster} has been updated to version`);
  });

  it('displays button to uninstall the Operator', async() => {
    await browser.get(`${appHost}/operatorhub/ns/${testName}`);
    await crudView.isLoaded();
    await catalogPageView.clickFilterCheckbox('providerType-red-hat');
    await catalogPageView.clickFilterCheckbox('installState-installed');
    await catalogPageView.catalogTileFor('Elasticsearch Operator').click();
    await operatorHubView.operatorModalIsLoaded();

    expect(operatorHubView.operatorModalUninstallBtn.isDisplayed()).toBe(true);
  });

  it('uninstalls Operator from the cluster', async() => {
    await operatorHubView.operatorModalUninstallBtn.click();
    await browser.wait(until.visibilityOf($('.co-catalog-install-modal')));
    await element(by.cssContainingText('#confirm-action', 'Remove')).click();
    await crudView.isLoaded();

    expect(crudView.rowForOperator('Elasticsearch Operator').isPresent()).toBe(false);
  });
});
