// Selected canonical Maven 3.3.4 and Gradle 9.8.0 wrapper artifacts.
// Properties are exact data contracts; platform scripts are bound without claiming Windows execution.
export const jvmWrapperPins = [
  {
    kind: "gradle",
    path: "gradlew",
    bytes: 8656,
    sha256: "a5a5c199ba02189ae8c46a334223371a20599d9c298ef65e7540ede4a3f72d59",
  },
  {
    kind: "gradle",
    path: "gradlew.bat",
    bytes: 4888,
    sha256: "f17917f8dbe61182b149273ee78090fec1197442c3f38276af907bfa5190db16",
  },
  {
    kind: "gradle",
    path: "gradle/wrapper/gradle-wrapper.jar",
    bytes: 47623,
    sha256: "238e777fcddd7e34f9708186085def2abd6e08e658505b38718d79d74c21abd5",
  },
  {
    kind: "gradle",
    path: "gradle/wrapper/gradle-wrapper.properties",
    bytes: 369,
    sha256: "acc4c8711f37414f247408726a36db4360f169c4319378ec02485465df67527d",
  },
  {
    kind: "maven",
    path: "mvnw",
    bytes: 11336,
    sha256: "07e72ac35ecf8c24db67498fc6a9a8e7c64b31ab3798a7119fe73fb7cd6c0331",
  },
  {
    kind: "maven",
    path: "mvnw.cmd",
    bytes: 7903,
    sha256: "8c720db91d96ba5f67afa4083726b20eb4be399d86bb859e09eb67436bb230f5",
  },
  {
    kind: "maven",
    path: ".mvn/wrapper/maven-wrapper.jar",
    bytes: 63093,
    sha256: "4e2fbf6554bc8a4702cdfdd3bef464f423393d784ddbb037216320ce55d5e4e1",
  },
  {
    kind: "maven",
    path: ".mvn/wrapper/maven-wrapper.properties",
    bytes: 431,
    sha256: "59839817a504dc4fa0fc0e07d83a2a772e4b474c97e21f4f57e949bfb495bdb1",
  },
] as const;
export const jvmWrapperArchives = {
  maven: {
    file: "apache-maven-3.10.0-bin.zip",
    url: "https://downloads.apache.org/maven/maven-3/3.10.0/binaries/apache-maven-3.10.0-bin.zip",
    bytes: 10102082,
    sha256: "1f6d9909266510f039f59aa0e13dcd2c66da85f043e56276e41f2918f8bddaff",
  },
  gradle: {
    file: "gradle-9.8.0-bin.zip",
    url: "https://services.gradle.org/distributions/gradle-9.8.0-bin.zip",
    bytes: 151611662,
    sha256: "bafd5ce9cfaea0fbccfdc8439a1ac42fbd4cd9c89dc9a988228d8a2639a58e6c",
  },
} as const;

export const jvmWrapperProperties = {
  maven:
    "wrapperVersion=3.3.4\ndistributionType=bin\ndistributionUrl=https://downloads.apache.org/maven/maven-3/3.10.0/binaries/apache-maven-3.10.0-bin.zip\ndistributionSha256Sum=1f6d9909266510f039f59aa0e13dcd2c66da85f043e56276e41f2918f8bddaff\nwrapperUrl=https://repo.maven.apache.org/maven2/org/apache/maven/wrapper/maven-wrapper/3.3.4/maven-wrapper-3.3.4.jar\nwrapperSha256Sum=4e2fbf6554bc8a4702cdfdd3bef464f423393d784ddbb037216320ce55d5e4e1\n",
  gradle:
    "distributionBase=GRADLE_USER_HOME\ndistributionPath=wrapper/dists\ndistributionSha256Sum=bafd5ce9cfaea0fbccfdc8439a1ac42fbd4cd9c89dc9a988228d8a2639a58e6c\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-9.8.0-bin.zip\nnetworkTimeout=10000\nretries=0\nretryBackOffMs=500\nvalidateDistributionUrl=false\nzipStoreBase=GRADLE_USER_HOME\nzipStorePath=wrapper/dists\n",
} as const;
