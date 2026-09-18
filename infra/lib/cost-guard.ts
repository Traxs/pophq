import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { KILL_SWITCH_ENTRY, LOCK_FILE, REPO_ROOT } from "./config.js";

export interface CostGuardProps {
  /** Monthly budget in USD; alerts at 50 % and 100 % (actual) and 100 % (forecast). */
  monthlyBudgetUsd: number;
  /** Actual spend in USD at which the kill switch turns on. */
  tripAtUsd: number;
  /**
   * SSM parameter holding the alert email address. Created once by the owner, outside Git,
   * so the address never lands in this public repository.
   */
  alertEmailParameter: string;
}

/** Budget alerts and the kill switch (P1.12, FM-13). */
export class CostGuard extends Construct {
  readonly killSwitch: ssm.StringParameter;

  constructor(scope: Construct, id: string, props: CostGuardProps) {
    super(scope, id);
    const { account } = Stack.of(this);

    this.killSwitch = new ssm.StringParameter(this, "KillSwitch", {
      parameterName: "/pophq/kill-switch",
      stringValue: "off",
      description: 'POP HQ kill switch. "on" = the API answers 503. Set back to "off" by hand.',
    });

    const email = ssm.StringParameter.valueForStringParameter(this, props.alertEmailParameter);
    const topic = (name: string) => {
      const t = new sns.Topic(this, name, { enforceSSL: true });
      t.addToResourcePolicy(
        new iam.PolicyStatement({
          principals: [new iam.ServicePrincipal("budgets.amazonaws.com")],
          actions: ["sns:Publish"],
          resources: [t.topicArn],
          conditions: { StringEquals: { "aws:SourceAccount": account } },
        }),
      );
      t.addSubscription(new subs.EmailSubscription(email));
      return t;
    };
    const alerts = topic("AlertsTopic");
    const trip = topic("TripTopic");

    const tripFn = new NodejsFunction(this, "Trip", {
      entry: KILL_SWITCH_ENTRY,
      projectRoot: REPO_ROOT,
      depsLockFilePath: LOCK_FILE,
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(10),
      loggingFormat: lambda.LoggingFormat.JSON,
      logGroup: new logs.LogGroup(this, "TripLogs", {
        retention: logs.RetentionDays.ONE_YEAR,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: { KILL_SWITCH_PARAMETER: this.killSwitch.parameterName },
      bundling: { format: OutputFormat.ESM, target: "node24", minify: true, externalModules: [] },
    });
    this.killSwitch.grantWrite(tripFn);
    trip.addSubscription(new subs.LambdaSubscription(tripFn));

    const notify = (
      topicArn: string,
      notificationType: "ACTUAL" | "FORECASTED",
      threshold: number,
      thresholdType: "PERCENTAGE" | "ABSOLUTE_VALUE",
    ): budgets.CfnBudget.NotificationWithSubscribersProperty => ({
      notification: { notificationType, comparisonOperator: "GREATER_THAN", threshold, thresholdType },
      subscribers: [{ subscriptionType: "SNS", address: topicArn }],
    });

    new budgets.CfnBudget(this, "Budget", {
      budget: {
        budgetName: "pophq-monthly",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: props.monthlyBudgetUsd, unit: "USD" },
      },
      notificationsWithSubscribers: [
        notify(alerts.topicArn, "ACTUAL", 50, "PERCENTAGE"),
        notify(alerts.topicArn, "ACTUAL", 100, "PERCENTAGE"),
        notify(alerts.topicArn, "FORECASTED", 100, "PERCENTAGE"),
        notify(trip.topicArn, "ACTUAL", props.tripAtUsd, "ABSOLUTE_VALUE"),
      ],
    });
  }
}
