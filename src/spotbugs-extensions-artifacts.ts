// Public native metadata from the pinned SpotBugs 4.10.4 core artifact.
export const spotbugsCorePluginId = "edu.umd.cs.findbugs.plugins.core";
export const spotbugsCorePatterns = [
  {
    type: "AA_ASSERTION_OF_ARGUMENTS",
    abbreviation: "AA",
    category: "BAD_PRACTICE",
  },
  {
    type: "AM_CREATES_EMPTY_JAR_FILE_ENTRY",
    abbreviation: "AM",
    category: "BAD_PRACTICE",
  },
  {
    type: "AM_CREATES_EMPTY_ZIP_FILE_ENTRY",
    abbreviation: "AM",
    category: "BAD_PRACTICE",
  },
  {
    type: "ASE_ASSERTION_WITH_SIDE_EFFECT",
    abbreviation: "ASE",
    category: "SECURITY",
  },
  {
    type: "ASE_ASSERTION_WITH_SIDE_EFFECT_METHOD",
    abbreviation: "ASE",
    category: "SECURITY",
  },
  {
    type: "AT_NONATOMIC_64BIT_PRIMITIVE",
    abbreviation: "AT",
    category: "MT_CORRECTNESS",
  },
  {
    type: "AT_NONATOMIC_OPERATIONS_ON_SHARED_VARIABLE",
    abbreviation: "AT",
    category: "MT_CORRECTNESS",
  },
  {
    type: "AT_OPERATION_SEQUENCE_ON_CONCURRENT_ABSTRACTION",
    abbreviation: "AT",
    category: "MT_CORRECTNESS",
  },
  {
    type: "AT_STALE_THREAD_WRITE_OF_PRIMITIVE",
    abbreviation: "AT",
    category: "MT_CORRECTNESS",
  },
  {
    type: "AT_UNSAFE_RESOURCE_ACCESS_IN_THREAD",
    abbreviation: "AT",
    category: "MT_CORRECTNESS",
  },
  {
    type: "BAC_BAD_APPLET_CONSTRUCTOR",
    abbreviation: "BAC",
    category: "CORRECTNESS",
  },
  {
    type: "BC_BAD_CAST_TO_ABSTRACT_COLLECTION",
    abbreviation: "BC",
    category: "STYLE",
  },
  {
    type: "BC_BAD_CAST_TO_CONCRETE_COLLECTION",
    abbreviation: "BC",
    category: "STYLE",
  },
  {
    type: "BC_EQUALS_METHOD_SHOULD_WORK_FOR_ALL_OBJECTS",
    abbreviation: "BC",
    category: "BAD_PRACTICE",
  },
  {
    type: "BC_IMPOSSIBLE_CAST",
    abbreviation: "BC",
    category: "CORRECTNESS",
  },
  {
    type: "BC_IMPOSSIBLE_CAST_PRIMITIVE_ARRAY",
    abbreviation: "BC",
    category: "CORRECTNESS",
  },
  {
    type: "BC_IMPOSSIBLE_DOWNCAST",
    abbreviation: "BC",
    category: "CORRECTNESS",
  },
  {
    type: "BC_IMPOSSIBLE_DOWNCAST_OF_TOARRAY",
    abbreviation: "BC",
    category: "CORRECTNESS",
  },
  {
    type: "BC_IMPOSSIBLE_INSTANCEOF",
    abbreviation: "BC",
    category: "CORRECTNESS",
  },
  {
    type: "BC_UNCONFIRMED_CAST",
    abbreviation: "BC",
    category: "STYLE",
  },
  {
    type: "BC_UNCONFIRMED_CAST_OF_RETURN_VALUE",
    abbreviation: "BC",
    category: "STYLE",
  },
  {
    type: "BC_VACUOUS_INSTANCEOF",
    abbreviation: "BC",
    category: "STYLE",
  },
  {
    type: "BIT_ADD_OF_SIGNED_BYTE",
    abbreviation: "BIT",
    category: "CORRECTNESS",
  },
  {
    type: "BIT_AND",
    abbreviation: "BIT",
    category: "CORRECTNESS",
  },
  {
    type: "BIT_AND_ZZ",
    abbreviation: "BIT",
    category: "CORRECTNESS",
  },
  {
    type: "BIT_IOR",
    abbreviation: "BIT",
    category: "CORRECTNESS",
  },
  {
    type: "BIT_IOR_OF_SIGNED_BYTE",
    abbreviation: "BIT",
    category: "CORRECTNESS",
  },
  {
    type: "BIT_SIGNED_CHECK",
    abbreviation: "BIT",
    category: "BAD_PRACTICE",
  },
  {
    type: "BIT_SIGNED_CHECK_HIGH_BIT",
    abbreviation: "BIT",
    category: "CORRECTNESS",
  },
  {
    type: "BOA_BADLY_OVERRIDDEN_ADAPTER",
    abbreviation: "BOA",
    category: "CORRECTNESS",
  },
  {
    type: "BSHIFT_WRONG_ADD_PRIORITY",
    abbreviation: "BSHIFT",
    category: "CORRECTNESS",
  },
  {
    type: "BX_BOXING_IMMEDIATELY_UNBOXED",
    abbreviation: "Bx",
    category: "PERFORMANCE",
  },
  {
    type: "BX_BOXING_IMMEDIATELY_UNBOXED_TO_PERFORM_COERCION",
    abbreviation: "Bx",
    category: "PERFORMANCE",
  },
  {
    type: "BX_UNBOXED_AND_COERCED_FOR_TERNARY_OPERATOR",
    abbreviation: "Bx",
    category: "PERFORMANCE",
  },
  {
    type: "BX_UNBOXING_IMMEDIATELY_REBOXED",
    abbreviation: "Bx",
    category: "PERFORMANCE",
  },
  {
    type: "CAA_COVARIANT_ARRAY_ELEMENT_STORE",
    abbreviation: "CAA",
    category: "CORRECTNESS",
  },
  {
    type: "CAA_COVARIANT_ARRAY_FIELD",
    abbreviation: "CAA",
    category: "STYLE",
  },
  {
    type: "CAA_COVARIANT_ARRAY_LOCAL",
    abbreviation: "CAA",
    category: "STYLE",
  },
  {
    type: "CAA_COVARIANT_ARRAY_RETURN",
    abbreviation: "CAA",
    category: "STYLE",
  },
  {
    type: "CD_CIRCULAR_DEPENDENCY",
    abbreviation: "CD",
    category: "STYLE",
  },
  {
    type: "CI_CONFUSED_INHERITANCE",
    abbreviation: "CI",
    category: "STYLE",
  },
  {
    type: "CNT_ROUGH_CONSTANT_VALUE",
    abbreviation: "CNT",
    category: "BAD_PRACTICE",
  },
  {
    type: "CN_IDIOM",
    abbreviation: "CN",
    category: "BAD_PRACTICE",
  },
  {
    type: "CN_IDIOM_NO_SUPER_CALL",
    abbreviation: "CN",
    category: "BAD_PRACTICE",
  },
  {
    type: "CN_IMPLEMENTS_CLONE_BUT_NOT_CLONEABLE",
    abbreviation: "CN",
    category: "BAD_PRACTICE",
  },
  {
    type: "CO_ABSTRACT_SELF",
    abbreviation: "Co",
    category: "BAD_PRACTICE",
  },
  {
    type: "CO_COMPARETO_INCORRECT_FLOATING",
    abbreviation: "Co",
    category: "BAD_PRACTICE",
  },
  {
    type: "CO_COMPARETO_RESULTS_MIN_VALUE",
    abbreviation: "Co",
    category: "BAD_PRACTICE",
  },
  {
    type: "CO_SELF_NO_OBJECT",
    abbreviation: "Co",
    category: "BAD_PRACTICE",
  },
  {
    type: "CT_CONSTRUCTOR_THROW",
    abbreviation: "CT",
    category: "BAD_PRACTICE",
  },
  {
    type: "CWO_CLOSED_WITHOUT_OPENED",
    abbreviation: "CWO",
    category: "MT_CORRECTNESS",
  },
  {
    type: "DB_DUPLICATE_BRANCHES",
    abbreviation: "DB",
    category: "STYLE",
  },
  {
    type: "DB_DUPLICATE_SWITCH_CLAUSES",
    abbreviation: "DB",
    category: "STYLE",
  },
  {
    type: "DCN_NULLPOINTER_EXCEPTION",
    abbreviation: "DCN",
    category: "STYLE",
  },
  {
    type: "DC_DOUBLECHECK",
    abbreviation: "DC",
    category: "MT_CORRECTNESS",
  },
  {
    type: "DC_PARTIALLY_CONSTRUCTED",
    abbreviation: "DC",
    category: "MT_CORRECTNESS",
  },
  {
    type: "DE_MIGHT_DROP",
    abbreviation: "DE",
    category: "BAD_PRACTICE",
  },
  {
    type: "DE_MIGHT_IGNORE",
    abbreviation: "DE",
    category: "BAD_PRACTICE",
  },
  {
    type: "DLS_DEAD_LOCAL_INCREMENT_IN_RETURN",
    abbreviation: "DLS",
    category: "CORRECTNESS",
  },
  {
    type: "DLS_DEAD_LOCAL_STORE",
    abbreviation: "DLS",
    category: "STYLE",
  },
  {
    type: "DLS_DEAD_LOCAL_STORE_IN_RETURN",
    abbreviation: "DLS",
    category: "STYLE",
  },
  {
    type: "DLS_DEAD_LOCAL_STORE_OF_NULL",
    abbreviation: "DLS",
    category: "STYLE",
  },
  {
    type: "DLS_DEAD_LOCAL_STORE_SHADOWS_FIELD",
    abbreviation: "DLS",
    category: "STYLE",
  },
  {
    type: "DLS_DEAD_STORE_OF_CLASS_LITERAL",
    abbreviation: "DLS",
    category: "CORRECTNESS",
  },
  {
    type: "DLS_OVERWRITTEN_INCREMENT",
    abbreviation: "DLS",
    category: "CORRECTNESS",
  },
  {
    type: "DL_SYNCHRONIZATION_ON_BOOLEAN",
    abbreviation: "DL",
    category: "MT_CORRECTNESS",
  },
  {
    type: "DL_SYNCHRONIZATION_ON_BOXED_PRIMITIVE",
    abbreviation: "DL",
    category: "MT_CORRECTNESS",
  },
  {
    type: "DL_SYNCHRONIZATION_ON_INTERNED_STRING",
    abbreviation: "DL",
    category: "MT_CORRECTNESS",
  },
  {
    type: "DL_SYNCHRONIZATION_ON_SHARED_CONSTANT",
    abbreviation: "DL",
    category: "MT_CORRECTNESS",
  },
  {
    type: "DL_SYNCHRONIZATION_ON_UNSHARED_BOXED_PRIMITIVE",
    abbreviation: "DL",
    category: "MT_CORRECTNESS",
  },
  {
    type: "DMI_ANNOTATION_IS_NOT_VISIBLE_TO_REFLECTION",
    abbreviation: "Dm",
    category: "CORRECTNESS",
  },
  {
    type: "DMI_ARGUMENTS_WRONG_ORDER",
    abbreviation: "DMI",
    category: "CORRECTNESS",
  },
  {
    type: "DMI_BAD_MONTH",
    abbreviation: "DMI",
    category: "CORRECTNESS",
  },
  {
    type: "DMI_BIGDECIMAL_CONSTRUCTED_FROM_DOUBLE",
    abbreviation: "DMI",
    category: "CORRECTNESS",
  },
  {
    type: "DMI_BLOCKING_METHODS_ON_URL",
    abbreviation: "Dm",
    category: "PERFORMANCE",
  },
  {
    type: "DMI_CALLING_NEXT_FROM_HASNEXT",
    abbreviation: "DMI",
    category: "CORRECTNESS",
  },
  {
    type: "DMI_COLLECTIONS_SHOULD_NOT_CONTAIN_THEMSELVES",
    abbreviation: "DMI",
    category: "CORRECTNESS",
  },
  {
    type: "DMI_COLLECTION_OF_URLS",
    abbreviation: "Dm",
    category: "PERFORMANCE",
  },
  {
    type: "DMI_CONSTANT_DB_PASSWORD",
    abbreviation: "Dm",
    category: "SECURITY",
  },
  {
    type: "DMI_DOH",
    abbreviation: "DMI",
    category: "CORRECTNESS",
  },
  {
    type: "DMI_EMPTY_DB_PASSWORD",
    abbreviation: "Dm",
    category: "SECURITY",
  },
  {
    type: "DMI_ENTRY_SETS_MAY_REUSE_ENTRY_OBJECTS",
    abbreviation: "DMI",
    category: "BAD_PRACTICE",
  },
  {
    type: "DMI_FUTILE_ATTEMPT_TO_CHANGE_MAXPOOL_SIZE_OF_SCHEDULED_THREAD_POOL_EXECUTOR",
    abbreviation: "Dm",
    category: "CORRECTNESS",
  },
  {
    type: "DMI_HARDCODED_ABSOLUTE_FILENAME",
    abbreviation: "DMI",
    category: "STYLE",
  },
  {
    type: "DMI_INVOKING_HASHCODE_ON_ARRAY",
    abbreviation: "DMI",
    category: "CORRECTNESS",
  },
  {
    type: "DMI_INVOKING_TOSTRING_ON_ANONYMOUS_ARRAY",
    abbreviation: "USELESS_STRING",
    category: "CORRECTNESS",
  },
  {
    type: "DMI_INVOKING_TOSTRING_ON_ARRAY",
    abbreviation: "USELESS_STRING",
    category: "CORRECTNESS",
  },
  {
    type: "DMI_LONG_BITS_TO_DOUBLE_INVOKED_ON_INT",
    abbreviation: "DMI",
    category: "CORRECTNESS",
  },
  {
    type: "DMI_MISLEADING_SUBSTRING",
    abbreviation: "DMI",
    category: "STYLE",
  },
  {
    type: "DMI_NONSERIALIZABLE_OBJECT_WRITTEN",
    abbreviation: "DMI",
    category: "STYLE",
  },
  {
    type: "DMI_RANDOM_USED_ONLY_ONCE",
    abbreviation: "DMI",
    category: "BAD_PRACTICE",
  },
  {
    type: "DMI_SCHEDULED_THREAD_POOL_EXECUTOR_WITH_ZERO_CORE_THREADS",
    abbreviation: "Dm",
    category: "CORRECTNESS",
  },
  {
    type: "DMI_THREAD_PASSED_WHERE_RUNNABLE_EXPECTED",
    abbreviation: "Dm",
    category: "STYLE",
  },
  {
    type: "DMI_UNSUPPORTED_METHOD",
    abbreviation: "Dm",
    category: "STYLE",
  },
  {
    type: "DMI_USELESS_SUBSTRING",
    abbreviation: "DMI",
    category: "STYLE",
  },
  {
    type: "DMI_USING_REMOVEALL_TO_CLEAR_COLLECTION",
    abbreviation: "DMI",
    category: "BAD_PRACTICE",
  },
  {
    type: "DMI_VACUOUS_CALL_TO_EASYMOCK_METHOD",
    abbreviation: "Dm",
    category: "CORRECTNESS",
  },
  {
    type: "DMI_VACUOUS_SELF_COLLECTION_CALL",
    abbreviation: "DMI",
    category: "CORRECTNESS",
  },
  {
    type: "DM_BOOLEAN_CTOR",
    abbreviation: "Dm",
    category: "PERFORMANCE",
  },
  {
    type: "DM_BOXED_PRIMITIVE_FOR_COMPARE",
    abbreviation: "Bx",
    category: "PERFORMANCE",
  },
  {
    type: "DM_BOXED_PRIMITIVE_FOR_PARSING",
    abbreviation: "Bx",
    category: "PERFORMANCE",
  },
  {
    type: "DM_BOXED_PRIMITIVE_TOSTRING",
    abbreviation: "Bx",
    category: "PERFORMANCE",
  },
  {
    type: "DM_CONVERT_CASE",
    abbreviation: "Dm",
    category: "I18N",
  },
  {
    type: "DM_DEFAULT_ENCODING",
    abbreviation: "Dm",
    category: "I18N",
  },
  {
    type: "DM_EXIT",
    abbreviation: "Dm",
    category: "BAD_PRACTICE",
  },
  {
    type: "DM_FP_NUMBER_CTOR",
    abbreviation: "Bx",
    category: "PERFORMANCE",
  },
  {
    type: "DM_GC",
    abbreviation: "Dm",
    category: "PERFORMANCE",
  },
  {
    type: "DM_INVALID_MIN_MAX",
    abbreviation: "Dm",
    category: "CORRECTNESS",
  },
  {
    type: "DM_MONITOR_WAIT_ON_CONDITION",
    abbreviation: "Dm",
    category: "MT_CORRECTNESS",
  },
  {
    type: "DM_NEW_FOR_GETCLASS",
    abbreviation: "Dm",
    category: "PERFORMANCE",
  },
  {
    type: "DM_NEXTINT_VIA_NEXTDOUBLE",
    abbreviation: "Dm",
    category: "PERFORMANCE",
  },
  {
    type: "DM_NUMBER_CTOR",
    abbreviation: "Bx",
    category: "PERFORMANCE",
  },
  {
    type: "DM_RUN_FINALIZERS_ON_EXIT",
    abbreviation: "Dm",
    category: "BAD_PRACTICE",
  },
  {
    type: "DM_STRING_CTOR",
    abbreviation: "Dm",
    category: "PERFORMANCE",
  },
  {
    type: "DM_STRING_TOSTRING",
    abbreviation: "Dm",
    category: "PERFORMANCE",
  },
  {
    type: "DM_STRING_VOID_CTOR",
    abbreviation: "Dm",
    category: "PERFORMANCE",
  },
  {
    type: "DM_USELESS_THREAD",
    abbreviation: "Dm",
    category: "MT_CORRECTNESS",
  },
  {
    type: "DP_CREATE_CLASSLOADER_INSIDE_DO_PRIVILEGED",
    abbreviation: "DP",
    category: "MALICIOUS_CODE",
  },
  {
    type: "DP_DO_INSIDE_DO_PRIVILEGED",
    abbreviation: "DP",
    category: "MALICIOUS_CODE",
  },
  {
    type: "EC_ARRAY_AND_NONARRAY",
    abbreviation: "EC",
    category: "CORRECTNESS",
  },
  {
    type: "EC_BAD_ARRAY_COMPARE",
    abbreviation: "EC",
    category: "CORRECTNESS",
  },
  {
    type: "EC_INCOMPATIBLE_ARRAY_COMPARE",
    abbreviation: "EC",
    category: "CORRECTNESS",
  },
  {
    type: "EC_NULL_ARG",
    abbreviation: "EC",
    category: "CORRECTNESS",
  },
  {
    type: "EC_UNRELATED_CLASS_AND_INTERFACE",
    abbreviation: "EC",
    category: "CORRECTNESS",
  },
  {
    type: "EC_UNRELATED_INTERFACES",
    abbreviation: "EC",
    category: "CORRECTNESS",
  },
  {
    type: "EC_UNRELATED_TYPES",
    abbreviation: "EC",
    category: "CORRECTNESS",
  },
  {
    type: "EC_UNRELATED_TYPES_USING_POINTER_EQUALITY",
    abbreviation: "EC",
    category: "CORRECTNESS",
  },
  {
    type: "EI_EXPOSE_BUF",
    abbreviation: "EI",
    category: "MALICIOUS_CODE",
  },
  {
    type: "EI_EXPOSE_BUF2",
    abbreviation: "EI2",
    category: "MALICIOUS_CODE",
  },
  {
    type: "EI_EXPOSE_REP",
    abbreviation: "EI",
    category: "MALICIOUS_CODE",
  },
  {
    type: "EI_EXPOSE_REP2",
    abbreviation: "EI2",
    category: "MALICIOUS_CODE",
  },
  {
    type: "EI_EXPOSE_STATIC_BUF2",
    abbreviation: "MS",
    category: "MALICIOUS_CODE",
  },
  {
    type: "EI_EXPOSE_STATIC_REP2",
    abbreviation: "MS",
    category: "MALICIOUS_CODE",
  },
  {
    type: "ENV_USE_PROPERTY_INSTEAD_OF_ENV",
    abbreviation: "ENV",
    category: "BAD_PRACTICE",
  },
  {
    type: "EOS_BAD_END_OF_STREAM_CHECK",
    abbreviation: "EOS",
    category: "CORRECTNESS",
  },
  {
    type: "EQ_ABSTRACT_SELF",
    abbreviation: "Eq",
    category: "BAD_PRACTICE",
  },
  {
    type: "EQ_ALWAYS_FALSE",
    abbreviation: "Eq",
    category: "CORRECTNESS",
  },
  {
    type: "EQ_ALWAYS_TRUE",
    abbreviation: "Eq",
    category: "CORRECTNESS",
  },
  {
    type: "EQ_CHECK_FOR_OPERAND_NOT_COMPATIBLE_WITH_THIS",
    abbreviation: "Eq",
    category: "BAD_PRACTICE",
  },
  {
    type: "EQ_COMPARETO_USE_OBJECT_EQUALS",
    abbreviation: "Eq",
    category: "BAD_PRACTICE",
  },
  {
    type: "EQ_COMPARING_CLASS_NAMES",
    abbreviation: "Eq",
    category: "CORRECTNESS",
  },
  {
    type: "EQ_DOESNT_OVERRIDE_EQUALS",
    abbreviation: "Eq",
    category: "STYLE",
  },
  {
    type: "EQ_DONT_DEFINE_EQUALS_FOR_ENUM",
    abbreviation: "Eq",
    category: "CORRECTNESS",
  },
  {
    type: "EQ_GETCLASS_AND_CLASS_CONSTANT",
    abbreviation: "Eq",
    category: "BAD_PRACTICE",
  },
  {
    type: "EQ_OTHER_NO_OBJECT",
    abbreviation: "Eq",
    category: "CORRECTNESS",
  },
  {
    type: "EQ_OTHER_USE_OBJECT",
    abbreviation: "Eq",
    category: "CORRECTNESS",
  },
  {
    type: "EQ_OVERRIDING_EQUALS_NOT_SYMMETRIC",
    abbreviation: "Eq",
    category: "CORRECTNESS",
  },
  {
    type: "EQ_SELF_NO_OBJECT",
    abbreviation: "Eq",
    category: "BAD_PRACTICE",
  },
  {
    type: "EQ_SELF_USE_OBJECT",
    abbreviation: "Eq",
    category: "CORRECTNESS",
  },
  {
    type: "EQ_UNUSUAL",
    abbreviation: "Eq",
    category: "STYLE",
  },
  {
    type: "ES_COMPARING_PARAMETER_STRING_WITH_EQ",
    abbreviation: "ES",
    category: "BAD_PRACTICE",
  },
  {
    type: "ES_COMPARING_STRINGS_WITH_EQ",
    abbreviation: "ES",
    category: "BAD_PRACTICE",
  },
  {
    type: "ESync_EMPTY_SYNC",
    abbreviation: "ESync",
    category: "MT_CORRECTNESS",
  },
  {
    type: "FB_MISSING_EXPECTED_WARNING",
    abbreviation: "FB",
    category: "CORRECTNESS",
  },
  {
    type: "FB_UNEXPECTED_WARNING",
    abbreviation: "FB",
    category: "CORRECTNESS",
  },
  {
    type: "FE_FLOATING_POINT_EQUALITY",
    abbreviation: "FE",
    category: "STYLE",
  },
  {
    type: "FE_TEST_IF_EQUAL_TO_NOT_A_NUMBER",
    abbreviation: "FE",
    category: "CORRECTNESS",
  },
  {
    type: "FI_EMPTY",
    abbreviation: "FI",
    category: "BAD_PRACTICE",
  },
  {
    type: "FI_EXPLICIT_INVOCATION",
    abbreviation: "FI",
    category: "BAD_PRACTICE",
  },
  {
    type: "FI_FINALIZER_NULLS_FIELDS",
    abbreviation: "FI",
    category: "BAD_PRACTICE",
  },
  {
    type: "FI_FINALIZER_ONLY_NULLS_FIELDS",
    abbreviation: "FI",
    category: "BAD_PRACTICE",
  },
  {
    type: "FI_MISSING_SUPER_CALL",
    abbreviation: "FI",
    category: "BAD_PRACTICE",
  },
  {
    type: "FI_NULLIFY_SUPER",
    abbreviation: "FI",
    category: "BAD_PRACTICE",
  },
  {
    type: "FI_PUBLIC_SHOULD_BE_PROTECTED",
    abbreviation: "FI",
    category: "MALICIOUS_CODE",
  },
  {
    type: "FI_USELESS",
    abbreviation: "FI",
    category: "BAD_PRACTICE",
  },
  {
    type: "FL_FLOATS_AS_LOOP_COUNTERS",
    abbreviation: "FL",
    category: "CORRECTNESS",
  },
  {
    type: "FL_MATH_USING_FLOAT_PRECISION",
    abbreviation: "FL",
    category: "CORRECTNESS",
  },
  {
    type: "FS_BAD_DATE_FORMAT_FLAG_COMBO",
    abbreviation: "FS",
    category: "BAD_PRACTICE",
  },
  {
    type: "GC_UNCHECKED_TYPE_IN_GENERIC_CALL",
    abbreviation: "GC",
    category: "BAD_PRACTICE",
  },
  {
    type: "GC_UNRELATED_TYPES",
    abbreviation: "GC",
    category: "CORRECTNESS",
  },
  {
    type: "HE_EQUALS_NO_HASHCODE",
    abbreviation: "HE",
    category: "BAD_PRACTICE",
  },
  {
    type: "HE_EQUALS_USE_HASHCODE",
    abbreviation: "HE",
    category: "BAD_PRACTICE",
  },
  {
    type: "HE_HASHCODE_NO_EQUALS",
    abbreviation: "HE",
    category: "BAD_PRACTICE",
  },
  {
    type: "HE_HASHCODE_USE_OBJECT_EQUALS",
    abbreviation: "HE",
    category: "BAD_PRACTICE",
  },
  {
    type: "HE_INHERITS_EQUALS_USE_HASHCODE",
    abbreviation: "HE",
    category: "BAD_PRACTICE",
  },
  {
    type: "HE_SIGNATURE_DECLARES_HASHING_OF_UNHASHABLE_CLASS",
    abbreviation: "HE",
    category: "CORRECTNESS",
  },
  {
    type: "HE_USE_OF_UNHASHABLE_CLASS",
    abbreviation: "HE",
    category: "CORRECTNESS",
  },
  {
    type: "HRS_REQUEST_PARAMETER_TO_COOKIE",
    abbreviation: "HRS",
    category: "SECURITY",
  },
  {
    type: "HRS_REQUEST_PARAMETER_TO_HTTP_HEADER",
    abbreviation: "HRS",
    category: "SECURITY",
  },
  {
    type: "HSC_HUGE_SHARED_STRING_CONSTANT",
    abbreviation: "HSC",
    category: "PERFORMANCE",
  },
  {
    type: "HSM_HIDING_METHOD",
    abbreviation: "HSM",
    category: "CORRECTNESS",
  },
  {
    type: "IAOM_DO_NOT_INCREASE_METHOD_ACCESSIBILITY",
    abbreviation: "IAOM",
    category: "CORRECTNESS",
  },
  {
    type: "IA_AMBIGUOUS_INVOCATION_OF_INHERITED_OR_OUTER_METHOD",
    abbreviation: "IA",
    category: "STYLE",
  },
  {
    type: "ICAST_BAD_SHIFT_AMOUNT",
    abbreviation: "BSHIFT",
    category: "CORRECTNESS",
  },
  {
    type: "ICAST_IDIV_CAST_TO_DOUBLE",
    abbreviation: "ICAST",
    category: "STYLE",
  },
  {
    type: "ICAST_INTEGER_MULTIPLY_CAST_TO_LONG",
    abbreviation: "ICAST",
    category: "STYLE",
  },
  {
    type: "ICAST_INT_2_LONG_AS_INSTANT",
    abbreviation: "ICAST",
    category: "CORRECTNESS",
  },
  {
    type: "ICAST_INT_CAST_TO_DOUBLE_PASSED_TO_CEIL",
    abbreviation: "ICAST",
    category: "CORRECTNESS",
  },
  {
    type: "ICAST_INT_CAST_TO_FLOAT_PASSED_TO_ROUND",
    abbreviation: "ICAST",
    category: "CORRECTNESS",
  },
  {
    type: "ICAST_QUESTIONABLE_UNSIGNED_RIGHT_SHIFT",
    abbreviation: "BSHIFT",
    category: "STYLE",
  },
  {
    type: "IC_INIT_CIRCULARITY",
    abbreviation: "IC",
    category: "STYLE",
  },
  {
    type: "IC_SUPERCLASS_USES_SUBCLASS_DURING_INITIALIZATION",
    abbreviation: "IC",
    category: "BAD_PRACTICE",
  },
  {
    type: "IIL_ELEMENTS_GET_LENGTH_IN_LOOP",
    abbreviation: "IIL",
    category: "PERFORMANCE",
  },
  {
    type: "IIL_PATTERN_COMPILE_IN_LOOP",
    abbreviation: "IIL",
    category: "PERFORMANCE",
  },
  {
    type: "IIL_PATTERN_COMPILE_IN_LOOP_INDIRECT",
    abbreviation: "IIL",
    category: "PERFORMANCE",
  },
  {
    type: "IIL_PREPARE_STATEMENT_IN_LOOP",
    abbreviation: "IIL",
    category: "PERFORMANCE",
  },
  {
    type: "IIO_INEFFICIENT_INDEX_OF",
    abbreviation: "IIO",
    category: "PERFORMANCE",
  },
  {
    type: "IIO_INEFFICIENT_LAST_INDEX_OF",
    abbreviation: "IIO",
    category: "PERFORMANCE",
  },
  {
    type: "IJU_ASSERT_METHOD_INVOKED_FROM_RUN_METHOD",
    abbreviation: "IJU",
    category: "CORRECTNESS",
  },
  {
    type: "IJU_BAD_SUITE_METHOD",
    abbreviation: "IJU",
    category: "CORRECTNESS",
  },
  {
    type: "IJU_NO_TESTS",
    abbreviation: "IJU",
    category: "CORRECTNESS",
  },
  {
    type: "IJU_SETUP_NO_SUPER",
    abbreviation: "IJU",
    category: "CORRECTNESS",
  },
  {
    type: "IJU_SUITE_NOT_STATIC",
    abbreviation: "IJU",
    category: "CORRECTNESS",
  },
  {
    type: "IJU_TEARDOWN_NO_SUPER",
    abbreviation: "IJU",
    category: "CORRECTNESS",
  },
  {
    type: "IL_CONTAINER_ADDED_TO_ITSELF",
    abbreviation: "IL",
    category: "CORRECTNESS",
  },
  {
    type: "IL_INFINITE_LOOP",
    abbreviation: "IL",
    category: "CORRECTNESS",
  },
  {
    type: "IL_INFINITE_RECURSIVE_LOOP",
    abbreviation: "IL",
    category: "CORRECTNESS",
  },
  {
    type: "IMA_INEFFICIENT_MEMBER_ACCESS",
    abbreviation: "IMA",
    category: "PERFORMANCE",
  },
  {
    type: "IMSE_DONT_CATCH_IMSE",
    abbreviation: "IMSE",
    category: "BAD_PRACTICE",
  },
  {
    type: "IM_AVERAGE_COMPUTATION_COULD_OVERFLOW",
    abbreviation: "IM",
    category: "STYLE",
  },
  {
    type: "IM_BAD_CHECK_FOR_ODD",
    abbreviation: "IM",
    category: "STYLE",
  },
  {
    type: "IM_MULTIPLYING_RESULT_OF_IREM",
    abbreviation: "IM",
    category: "CORRECTNESS",
  },
  {
    type: "INT_BAD_COMPARISON_WITH_INT_VALUE",
    abbreviation: "INT",
    category: "CORRECTNESS",
  },
  {
    type: "INT_BAD_COMPARISON_WITH_NONNEGATIVE_VALUE",
    abbreviation: "INT",
    category: "CORRECTNESS",
  },
  {
    type: "INT_BAD_COMPARISON_WITH_SIGNED_BYTE",
    abbreviation: "INT",
    category: "CORRECTNESS",
  },
  {
    type: "INT_BAD_REM_BY_1",
    abbreviation: "INT",
    category: "STYLE",
  },
  {
    type: "INT_VACUOUS_BIT_OPERATION",
    abbreviation: "INT",
    category: "STYLE",
  },
  {
    type: "INT_VACUOUS_COMPARISON",
    abbreviation: "INT",
    category: "STYLE",
  },
  {
    type: "IO_APPENDING_TO_OBJECT_OUTPUT_STREAM",
    abbreviation: "IO",
    category: "CORRECTNESS",
  },
  {
    type: "IP_PARAMETER_IS_DEAD_BUT_OVERWRITTEN",
    abbreviation: "IP",
    category: "CORRECTNESS",
  },
  {
    type: "IS2_INCONSISTENT_SYNC",
    abbreviation: "IS",
    category: "MT_CORRECTNESS",
  },
  {
    type: "ISC_INSTANTIATE_STATIC_CLASS",
    abbreviation: "ISC",
    category: "BAD_PRACTICE",
  },
  {
    type: "IS_FIELD_NOT_GUARDED",
    abbreviation: "IS",
    category: "MT_CORRECTNESS",
  },
  {
    type: "IS_INCONSISTENT_SYNC",
    abbreviation: "IS",
    category: "MT_CORRECTNESS",
  },
  {
    type: "ITA_INEFFICIENT_TO_ARRAY",
    abbreviation: "ITA",
    category: "PERFORMANCE",
  },
  {
    type: "IT_NO_SUCH_ELEMENT",
    abbreviation: "It",
    category: "BAD_PRACTICE",
  },
  {
    type: "J2EE_STORE_OF_NON_SERIALIZABLE_OBJECT_INTO_SESSION",
    abbreviation: "J2EE",
    category: "BAD_PRACTICE",
  },
  {
    type: "JCIP_FIELD_ISNT_FINAL_IN_IMMUTABLE_CLASS",
    abbreviation: "JCIP",
    category: "BAD_PRACTICE",
  },
  {
    type: "JLM_JSR166_LOCK_MONITORENTER",
    abbreviation: "JLM",
    category: "MT_CORRECTNESS",
  },
  {
    type: "JLM_JSR166_UTILCONCURRENT_MONITORENTER",
    abbreviation: "JLM",
    category: "MT_CORRECTNESS",
  },
  {
    type: "JML_JSR166_CALLING_WAIT_RATHER_THAN_AWAIT",
    abbreviation: "JLM",
    category: "MT_CORRECTNESS",
  },
  {
    type: "JUA_DONT_ASSERT_INSTANCEOF_IN_TESTS",
    abbreviation: "JUA",
    category: "BAD_PRACTICE",
  },
  {
    type: "LG_LOST_LOGGER_DUE_TO_WEAK_REFERENCE",
    abbreviation: "LG",
    category: "EXPERIMENTAL",
  },
  {
    type: "LI_LAZY_INIT_STATIC",
    abbreviation: "LI",
    category: "MT_CORRECTNESS",
  },
  {
    type: "LI_LAZY_INIT_UPDATE_STATIC",
    abbreviation: "LI",
    category: "MT_CORRECTNESS",
  },
  {
    type: "MC_OVERRIDABLE_METHOD_CALL_IN_CLONE",
    abbreviation: "MC",
    category: "MALICIOUS_CODE",
  },
  {
    type: "MC_OVERRIDABLE_METHOD_CALL_IN_CONSTRUCTOR",
    abbreviation: "MC",
    category: "MALICIOUS_CODE",
  },
  {
    type: "MC_OVERRIDABLE_METHOD_CALL_IN_READ_OBJECT",
    abbreviation: "MC",
    category: "MALICIOUS_CODE",
  },
  {
    type: "ME_ENUM_FIELD_SETTER",
    abbreviation: "ME",
    category: "BAD_PRACTICE",
  },
  {
    type: "ME_MUTABLE_ENUM_FIELD",
    abbreviation: "ME",
    category: "BAD_PRACTICE",
  },
  {
    type: "MF_CLASS_MASKS_FIELD",
    abbreviation: "MF",
    category: "CORRECTNESS",
  },
  {
    type: "MF_METHOD_MASKS_FIELD",
    abbreviation: "MF",
    category: "CORRECTNESS",
  },
  {
    type: "ML_SYNC_ON_FIELD_TO_GUARD_CHANGING_THAT_FIELD",
    abbreviation: "ML",
    category: "MT_CORRECTNESS",
  },
  {
    type: "ML_SYNC_ON_UPDATED_FIELD",
    abbreviation: "ML",
    category: "MT_CORRECTNESS",
  },
  {
    type: "MSF_MUTABLE_SERVLET_FIELD",
    abbreviation: "MSF",
    category: "MT_CORRECTNESS",
  },
  {
    type: "MS_CANNOT_BE_FINAL",
    abbreviation: "MS",
    category: "MALICIOUS_CODE",
  },
  {
    type: "MS_EXPOSE_BUF",
    abbreviation: "MS",
    category: "MALICIOUS_CODE",
  },
  {
    type: "MS_EXPOSE_REP",
    abbreviation: "MS",
    category: "MALICIOUS_CODE",
  },
  {
    type: "MS_FINAL_PKGPROTECT",
    abbreviation: "MS",
    category: "MALICIOUS_CODE",
  },
  {
    type: "MS_MUTABLE_ARRAY",
    abbreviation: "MS",
    category: "MALICIOUS_CODE",
  },
  {
    type: "MS_MUTABLE_COLLECTION",
    abbreviation: "MS",
    category: "MALICIOUS_CODE",
  },
  {
    type: "MS_MUTABLE_COLLECTION_PKGPROTECT",
    abbreviation: "MS",
    category: "MALICIOUS_CODE",
  },
  {
    type: "MS_MUTABLE_HASHTABLE",
    abbreviation: "MS",
    category: "MALICIOUS_CODE",
  },
  {
    type: "MS_OOI_PKGPROTECT",
    abbreviation: "MS",
    category: "MALICIOUS_CODE",
  },
  {
    type: "MS_PKGPROTECT",
    abbreviation: "MS",
    category: "MALICIOUS_CODE",
  },
  {
    type: "MS_SHOULD_BE_FINAL",
    abbreviation: "MS",
    category: "MALICIOUS_CODE",
  },
  {
    type: "MS_SHOULD_BE_REFACTORED_TO_BE_FINAL",
    abbreviation: "MS",
    category: "MALICIOUS_CODE",
  },
  {
    type: "MTIA_SUSPECT_SERVLET_INSTANCE_FIELD",
    abbreviation: "MTIA",
    category: "STYLE",
  },
  {
    type: "MTIA_SUSPECT_STRUTS_INSTANCE_FIELD",
    abbreviation: "MTIA",
    category: "STYLE",
  },
  {
    type: "MWN_MISMATCHED_NOTIFY",
    abbreviation: "MWN",
    category: "MT_CORRECTNESS",
  },
  {
    type: "MWN_MISMATCHED_WAIT",
    abbreviation: "MWN",
    category: "MT_CORRECTNESS",
  },
  {
    type: "NCR_NOT_PROPERLY_CHECKED_READ",
    abbreviation: "NCR",
    category: "BAD_PRACTICE",
  },
  {
    type: "NM_BAD_EQUAL",
    abbreviation: "Nm",
    category: "CORRECTNESS",
  },
  {
    type: "NM_CLASS_NAMING_CONVENTION",
    abbreviation: "Nm",
    category: "BAD_PRACTICE",
  },
  {
    type: "NM_CLASS_NOT_EXCEPTION",
    abbreviation: "Nm",
    category: "BAD_PRACTICE",
  },
  {
    type: "NM_CONFUSING",
    abbreviation: "Nm",
    category: "BAD_PRACTICE",
  },
  {
    type: "NM_FIELD_NAMING_CONVENTION",
    abbreviation: "Nm",
    category: "BAD_PRACTICE",
  },
  {
    type: "NM_FUTURE_KEYWORD_USED_AS_IDENTIFIER",
    abbreviation: "Nm",
    category: "BAD_PRACTICE",
  },
  {
    type: "NM_FUTURE_KEYWORD_USED_AS_MEMBER_IDENTIFIER",
    abbreviation: "Nm",
    category: "BAD_PRACTICE",
  },
  {
    type: "NM_LCASE_HASHCODE",
    abbreviation: "Nm",
    category: "CORRECTNESS",
  },
  {
    type: "NM_LCASE_TOSTRING",
    abbreviation: "Nm",
    category: "CORRECTNESS",
  },
  {
    type: "NM_METHOD_CONSTRUCTOR_CONFUSION",
    abbreviation: "Nm",
    category: "CORRECTNESS",
  },
  {
    type: "NM_METHOD_NAMING_CONVENTION",
    abbreviation: "Nm",
    category: "BAD_PRACTICE",
  },
  {
    type: "NM_SAME_SIMPLE_NAME_AS_INTERFACE",
    abbreviation: "Nm",
    category: "BAD_PRACTICE",
  },
  {
    type: "NM_SAME_SIMPLE_NAME_AS_SUPERCLASS",
    abbreviation: "Nm",
    category: "BAD_PRACTICE",
  },
  {
    type: "NM_VERY_CONFUSING",
    abbreviation: "Nm",
    category: "CORRECTNESS",
  },
  {
    type: "NM_VERY_CONFUSING_INTENTIONAL",
    abbreviation: "Nm",
    category: "BAD_PRACTICE",
  },
  {
    type: "NM_WRONG_PACKAGE",
    abbreviation: "Nm",
    category: "CORRECTNESS",
  },
  {
    type: "NM_WRONG_PACKAGE_INTENTIONAL",
    abbreviation: "Nm",
    category: "BAD_PRACTICE",
  },
  {
    type: "NN_NAKED_NOTIFY",
    abbreviation: "NN",
    category: "MT_CORRECTNESS",
  },
  {
    type: "NOISE_FIELD_REFERENCE",
    abbreviation: "NOISE",
    category: "NOISE",
  },
  {
    type: "NOISE_METHOD_CALL",
    abbreviation: "NOISE",
    category: "NOISE",
  },
  {
    type: "NOISE_NULL_DEREFERENCE",
    abbreviation: "NOISE",
    category: "NOISE",
  },
  {
    type: "NOISE_OPERATION",
    abbreviation: "NOISE",
    category: "NOISE",
  },
  {
    type: "NO_NOTIFY_NOT_NOTIFYALL",
    abbreviation: "No",
    category: "MT_CORRECTNESS",
  },
  {
    type: "NP_ALWAYS_NULL",
    abbreviation: "NP",
    category: "CORRECTNESS",
  },
  {
    type: "NP_ALWAYS_NULL_EXCEPTION",
    abbreviation: "NP",
    category: "CORRECTNESS",
  },
  {
    type: "NP_ARGUMENT_MIGHT_BE_NULL",
    abbreviation: "NP",
    category: "CORRECTNESS",
  },
  {
    type: "NP_BOOLEAN_RETURN_NULL",
    abbreviation: "NP",
    category: "BAD_PRACTICE",
  },
  {
    type: "NP_CLONE_COULD_RETURN_NULL",
    abbreviation: "NP",
    category: "BAD_PRACTICE",
  },
  {
    type: "NP_CLOSING_NULL",
    abbreviation: "NP",
    category: "CORRECTNESS",
  },
  {
    type: "NP_DEREFERENCE_OF_READLINE_VALUE",
    abbreviation: "NP",
    category: "STYLE",
  },
  {
    type: "NP_EQUALS_SHOULD_HANDLE_NULL_ARGUMENT",
    abbreviation: "NP",
    category: "BAD_PRACTICE",
  },
  {
    type: "NP_GUARANTEED_DEREF",
    abbreviation: "NP",
    category: "CORRECTNESS",
  },
  {
    type: "NP_GUARANTEED_DEREF_ON_EXCEPTION_PATH",
    abbreviation: "NP",
    category: "CORRECTNESS",
  },
  {
    type: "NP_IMMEDIATE_DEREFERENCE_OF_READLINE",
    abbreviation: "NP",
    category: "STYLE",
  },
  {
    type: "NP_LOAD_OF_KNOWN_NULL_VALUE",
    abbreviation: "NP",
    category: "STYLE",
  },
  {
    type: "NP_METHOD_PARAMETER_RELAXING_ANNOTATION",
    abbreviation: "NP",
    category: "STYLE",
  },
  {
    type: "NP_METHOD_PARAMETER_TIGHTENS_ANNOTATION",
    abbreviation: "NP",
    category: "STYLE",
  },
  {
    type: "NP_METHOD_RETURN_RELAXING_ANNOTATION",
    abbreviation: "NP",
    category: "STYLE",
  },
  {
    type: "NP_NONNULL_FIELD_NOT_INITIALIZED_IN_CONSTRUCTOR",
    abbreviation: "NP",
    category: "CORRECTNESS",
  },
  {
    type: "NP_NONNULL_PARAM_VIOLATION",
    abbreviation: "NP",
    category: "CORRECTNESS",
  },
  {
    type: "NP_NONNULL_RETURN_VIOLATION",
    abbreviation: "NP",
    category: "CORRECTNESS",
  },
  {
    type: "NP_NULL_INSTANCEOF",
    abbreviation: "NP",
    category: "CORRECTNESS",
  },
  {
    type: "NP_NULL_ON_SOME_PATH",
    abbreviation: "NP",
    category: "CORRECTNESS",
  },
  {
    type: "NP_NULL_ON_SOME_PATH_EXCEPTION",
    abbreviation: "NP",
    category: "CORRECTNESS",
  },
  {
    type: "NP_NULL_ON_SOME_PATH_FROM_RETURN_VALUE",
    abbreviation: "NP",
    category: "STYLE",
  },
  {
    type: "NP_NULL_ON_SOME_PATH_MIGHT_BE_INFEASIBLE",
    abbreviation: "NP",
    category: "STYLE",
  },
  {
    type: "NP_NULL_PARAM_DEREF",
    abbreviation: "NP",
    category: "CORRECTNESS",
  },
  {
    type: "NP_NULL_PARAM_DEREF_ALL_TARGETS_DANGEROUS",
    abbreviation: "NP",
    category: "CORRECTNESS",
  },
  {
    type: "NP_NULL_PARAM_DEREF_NONVIRTUAL",
    abbreviation: "NP",
    category: "CORRECTNESS",
  },
  {
    type: "NP_OPTIONAL_RETURN_NULL",
    abbreviation: "NP",
    category: "CORRECTNESS",
  },
  {
    type: "NP_PARAMETER_MUST_BE_NONNULL_BUT_MARKED_AS_NULLABLE",
    abbreviation: "NP",
    category: "STYLE",
  },
  {
    type: "NP_STORE_INTO_NONNULL_FIELD",
    abbreviation: "NP",
    category: "CORRECTNESS",
  },
  {
    type: "NP_SYNC_AND_NULL_CHECK_FIELD",
    abbreviation: "NP",
    category: "MT_CORRECTNESS",
  },
  {
    type: "NP_TOSTRING_COULD_RETURN_NULL",
    abbreviation: "NP",
    category: "BAD_PRACTICE",
  },
  {
    type: "NP_UNWRITTEN_FIELD",
    abbreviation: "NP",
    category: "CORRECTNESS",
  },
  {
    type: "NP_UNWRITTEN_PUBLIC_OR_PROTECTED_FIELD",
    abbreviation: "NP",
    category: "STYLE",
  },
  {
    type: "NS_DANGEROUS_NON_SHORT_CIRCUIT",
    abbreviation: "NS",
    category: "STYLE",
  },
  {
    type: "NS_NON_SHORT_CIRCUIT",
    abbreviation: "NS",
    category: "STYLE",
  },
  {
    type: "OBL_UNSATISFIED_OBLIGATION",
    abbreviation: "OBL",
    category: "EXPERIMENTAL",
  },
  {
    type: "OBL_UNSATISFIED_OBLIGATION_EXCEPTION_EDGE",
    abbreviation: "OBL",
    category: "EXPERIMENTAL",
  },
  {
    type: "ODR_OPEN_DATABASE_RESOURCE",
    abbreviation: "ODR",
    category: "BAD_PRACTICE",
  },
  {
    type: "ODR_OPEN_DATABASE_RESOURCE_EXCEPTION_PATH",
    abbreviation: "ODR",
    category: "BAD_PRACTICE",
  },
  {
    type: "OS_OPEN_STREAM",
    abbreviation: "OS",
    category: "BAD_PRACTICE",
  },
  {
    type: "OS_OPEN_STREAM_EXCEPTION_PATH",
    abbreviation: "OS",
    category: "BAD_PRACTICE",
  },
  {
    type: "OVERRIDING_METHODS_MUST_INVOKE_SUPER",
    abbreviation: "CN",
    category: "CORRECTNESS",
  },
  {
    type: "PA_PUBLIC_ARRAY_ATTRIBUTE",
    abbreviation: "PA",
    category: "BAD_PRACTICE",
  },
  {
    type: "PA_PUBLIC_MUTABLE_OBJECT_ATTRIBUTE",
    abbreviation: "PA",
    category: "BAD_PRACTICE",
  },
  {
    type: "PA_PUBLIC_PRIMITIVE_ATTRIBUTE",
    abbreviation: "PA",
    category: "BAD_PRACTICE",
  },
  {
    type: "PERM_SUPER_NOT_CALLED_IN_GETPERMISSIONS",
    abbreviation: "PERM",
    category: "MALICIOUS_CODE",
  },
  {
    type: "PI_DO_NOT_REUSE_PUBLIC_IDENTIFIERS_CLASS_NAMES",
    abbreviation: "PI",
    category: "BAD_PRACTICE",
  },
  {
    type: "PI_DO_NOT_REUSE_PUBLIC_IDENTIFIERS_FIELD_NAMES",
    abbreviation: "PI",
    category: "BAD_PRACTICE",
  },
  {
    type: "PI_DO_NOT_REUSE_PUBLIC_IDENTIFIERS_LOCAL_VARIABLE_NAMES",
    abbreviation: "PI",
    category: "BAD_PRACTICE",
  },
  {
    type: "PI_DO_NOT_REUSE_PUBLIC_IDENTIFIERS_METHOD_NAMES",
    abbreviation: "PI",
    category: "BAD_PRACTICE",
  },
  {
    type: "PS_PUBLIC_SEMAPHORES",
    abbreviation: "PS",
    category: "STYLE",
  },
  {
    type: "PT_ABSOLUTE_PATH_TRAVERSAL",
    abbreviation: "PT",
    category: "SECURITY",
  },
  {
    type: "PT_RELATIVE_PATH_TRAVERSAL",
    abbreviation: "PT",
    category: "SECURITY",
  },
  {
    type: "PZLA_PREFER_ZERO_LENGTH_ARRAYS",
    abbreviation: "PZLA",
    category: "STYLE",
  },
  {
    type: "PZ_DONT_REUSE_ENTRY_OBJECTS_IN_ITERATORS",
    abbreviation: "PZ",
    category: "BAD_PRACTICE",
  },
  {
    type: "QBA_QUESTIONABLE_BOOLEAN_ASSIGNMENT",
    abbreviation: "QBA",
    category: "CORRECTNESS",
  },
  {
    type: "QF_QUESTIONABLE_FOR_LOOP",
    abbreviation: "QF",
    category: "STYLE",
  },
  {
    type: "RANGE_ARRAY_INDEX",
    abbreviation: "RANGE",
    category: "CORRECTNESS",
  },
  {
    type: "RANGE_ARRAY_LENGTH",
    abbreviation: "RANGE",
    category: "CORRECTNESS",
  },
  {
    type: "RANGE_ARRAY_OFFSET",
    abbreviation: "RANGE",
    category: "CORRECTNESS",
  },
  {
    type: "RANGE_STRING_INDEX",
    abbreviation: "RANGE",
    category: "CORRECTNESS",
  },
  {
    type: "RCN_REDUNDANT_COMPARISON_OF_NULL_AND_NONNULL_VALUE",
    abbreviation: "RCN",
    category: "STYLE",
  },
  {
    type: "RCN_REDUNDANT_COMPARISON_TWO_NULL_VALUES",
    abbreviation: "RCN",
    category: "STYLE",
  },
  {
    type: "RCN_REDUNDANT_NULLCHECK_OF_NONNULL_VALUE",
    abbreviation: "RCN",
    category: "STYLE",
  },
  {
    type: "RCN_REDUNDANT_NULLCHECK_OF_NULL_VALUE",
    abbreviation: "RCN",
    category: "STYLE",
  },
  {
    type: "RCN_REDUNDANT_NULLCHECK_WOULD_HAVE_BEEN_A_NPE",
    abbreviation: "RCN",
    category: "CORRECTNESS",
  },
  {
    type: "RC_REF_COMPARISON",
    abbreviation: "RC",
    category: "CORRECTNESS",
  },
  {
    type: "RC_REF_COMPARISON_BAD_PRACTICE",
    abbreviation: "RC",
    category: "BAD_PRACTICE",
  },
  {
    type: "RC_REF_COMPARISON_BAD_PRACTICE_BOOLEAN",
    abbreviation: "RC",
    category: "BAD_PRACTICE",
  },
  {
    type: "REC_CATCH_EXCEPTION",
    abbreviation: "REC",
    category: "STYLE",
  },
  {
    type: "REFLC_REFLECTION_MAY_INCREASE_ACCESSIBILITY_OF_CLASS",
    abbreviation: "REFLC",
    category: "MALICIOUS_CODE",
  },
  {
    type: "REFLF_REFLECTION_MAY_INCREASE_ACCESSIBILITY_OF_FIELD",
    abbreviation: "REFLF",
    category: "MALICIOUS_CODE",
  },
  {
    type: "RE_BAD_SYNTAX_FOR_REGULAR_EXPRESSION",
    abbreviation: "RE",
    category: "CORRECTNESS",
  },
  {
    type: "RE_CANT_USE_FILE_SEPARATOR_AS_REGULAR_EXPRESSION",
    abbreviation: "RE",
    category: "CORRECTNESS",
  },
  {
    type: "RE_POSSIBLE_UNINTENDED_PATTERN",
    abbreviation: "RE",
    category: "CORRECTNESS",
  },
  {
    type: "RI_REDUNDANT_INTERFACES",
    abbreviation: "RI",
    category: "STYLE",
  },
  {
    type: "RR_NOT_CHECKED",
    abbreviation: "RR",
    category: "BAD_PRACTICE",
  },
  {
    type: "RS_READOBJECT_SYNC",
    abbreviation: "RS",
    category: "MT_CORRECTNESS",
  },
  {
    type: "RU_INVOKE_RUN",
    abbreviation: "Ru",
    category: "MT_CORRECTNESS",
  },
  {
    type: "RV_01_TO_INT",
    abbreviation: "RV",
    category: "CORRECTNESS",
  },
  {
    type: "RV_ABSOLUTE_VALUE_OF_HASHCODE",
    abbreviation: "RV",
    category: "CORRECTNESS",
  },
  {
    type: "RV_ABSOLUTE_VALUE_OF_RANDOM_INT",
    abbreviation: "RV",
    category: "CORRECTNESS",
  },
  {
    type: "RV_CHECK_COMPARETO_FOR_SPECIFIC_RETURN_VALUE",
    abbreviation: "RV",
    category: "CORRECTNESS",
  },
  {
    type: "RV_CHECK_FOR_POSITIVE_INDEXOF",
    abbreviation: "RV",
    category: "STYLE",
  },
  {
    type: "RV_DONT_JUST_NULL_CHECK_READLINE",
    abbreviation: "RV",
    category: "STYLE",
  },
  {
    type: "RV_EXCEPTION_NOT_THROWN",
    abbreviation: "RV",
    category: "CORRECTNESS",
  },
  {
    type: "RV_NEGATING_RESULT_OF_COMPARETO",
    abbreviation: "RV",
    category: "BAD_PRACTICE",
  },
  {
    type: "RV_REM_OF_HASHCODE",
    abbreviation: "RV",
    category: "STYLE",
  },
  {
    type: "RV_REM_OF_RANDOM_INT",
    abbreviation: "RV",
    category: "STYLE",
  },
  {
    type: "RV_RETURN_VALUE_IGNORED",
    abbreviation: "RV",
    category: "CORRECTNESS",
  },
  {
    type: "RV_RETURN_VALUE_IGNORED_BAD_PRACTICE",
    abbreviation: "RV",
    category: "BAD_PRACTICE",
  },
  {
    type: "RV_RETURN_VALUE_IGNORED_INFERRED",
    abbreviation: "RV",
    category: "STYLE",
  },
  {
    type: "RV_RETURN_VALUE_IGNORED_NO_SIDE_EFFECT",
    abbreviation: "RV",
    category: "STYLE",
  },
  {
    type: "RV_RETURN_VALUE_OF_PUTIFABSENT_IGNORED",
    abbreviation: "RV",
    category: "MT_CORRECTNESS",
  },
  {
    type: "RpC_REPEATED_CONDITIONAL_TEST",
    abbreviation: "RpC",
    category: "CORRECTNESS",
  },
  {
    type: "SA_FIELD_DOUBLE_ASSIGNMENT",
    abbreviation: "SA",
    category: "STYLE",
  },
  {
    type: "SA_FIELD_SELF_ASSIGNMENT",
    abbreviation: "SA",
    category: "CORRECTNESS",
  },
  {
    type: "SA_FIELD_SELF_COMPARISON",
    abbreviation: "SA",
    category: "CORRECTNESS",
  },
  {
    type: "SA_FIELD_SELF_COMPUTATION",
    abbreviation: "SA",
    category: "CORRECTNESS",
  },
  {
    type: "SA_LOCAL_DOUBLE_ASSIGNMENT",
    abbreviation: "SA",
    category: "STYLE",
  },
  {
    type: "SA_LOCAL_SELF_ASSIGNMENT",
    abbreviation: "SA",
    category: "STYLE",
  },
  {
    type: "SA_LOCAL_SELF_ASSIGNMENT_INSTEAD_OF_FIELD",
    abbreviation: "SA",
    category: "CORRECTNESS",
  },
  {
    type: "SA_LOCAL_SELF_COMPARISON",
    abbreviation: "SA",
    category: "CORRECTNESS",
  },
  {
    type: "SA_LOCAL_SELF_COMPUTATION",
    abbreviation: "SA",
    category: "CORRECTNESS",
  },
  {
    type: "SBSC_USE_STRINGBUFFER_CONCATENATION",
    abbreviation: "SBSC",
    category: "PERFORMANCE",
  },
  {
    type: "SC_START_IN_CTOR",
    abbreviation: "SC",
    category: "MT_CORRECTNESS",
  },
  {
    type: "SE_BAD_FIELD",
    abbreviation: "Se",
    category: "BAD_PRACTICE",
  },
  {
    type: "SE_BAD_FIELD_INNER_CLASS",
    abbreviation: "Se",
    category: "BAD_PRACTICE",
  },
  {
    type: "SE_BAD_FIELD_STORE",
    abbreviation: "Se",
    category: "BAD_PRACTICE",
  },
  {
    type: "SE_COMPARATOR_SHOULD_BE_SERIALIZABLE",
    abbreviation: "Se",
    category: "BAD_PRACTICE",
  },
  {
    type: "SE_INNER_CLASS",
    abbreviation: "Se",
    category: "BAD_PRACTICE",
  },
  {
    type: "SE_METHOD_MUST_BE_PRIVATE",
    abbreviation: "Se",
    category: "CORRECTNESS",
  },
  {
    type: "SE_NONFINAL_SERIALVERSIONID",
    abbreviation: "Se",
    category: "BAD_PRACTICE",
  },
  {
    type: "SE_NONLONG_SERIALVERSIONID",
    abbreviation: "Se",
    category: "BAD_PRACTICE",
  },
  {
    type: "SE_NONSTATIC_SERIALVERSIONID",
    abbreviation: "Se",
    category: "BAD_PRACTICE",
  },
  {
    type: "SE_NO_SERIALVERSIONID",
    abbreviation: "SnVI",
    category: "BAD_PRACTICE",
  },
  {
    type: "SE_NO_SUITABLE_CONSTRUCTOR",
    abbreviation: "Se",
    category: "BAD_PRACTICE",
  },
  {
    type: "SE_NO_SUITABLE_CONSTRUCTOR_FOR_EXTERNALIZATION",
    abbreviation: "Se",
    category: "BAD_PRACTICE",
  },
  {
    type: "SE_PREVENT_EXT_OBJ_OVERWRITE",
    abbreviation: "Se",
    category: "BAD_PRACTICE",
  },
  {
    type: "SE_PRIVATE_READ_RESOLVE_NOT_INHERITED",
    abbreviation: "Se",
    category: "STYLE",
  },
  {
    type: "SE_READ_RESOLVE_IS_STATIC",
    abbreviation: "Se",
    category: "CORRECTNESS",
  },
  {
    type: "SE_READ_RESOLVE_MUST_RETURN_OBJECT",
    abbreviation: "Se",
    category: "BAD_PRACTICE",
  },
  {
    type: "SE_TRANSIENT_FIELD_NOT_RESTORED",
    abbreviation: "Se",
    category: "BAD_PRACTICE",
  },
  {
    type: "SE_TRANSIENT_FIELD_OF_NONSERIALIZABLE_CLASS",
    abbreviation: "Se",
    category: "STYLE",
  },
  {
    type: "SF_DEAD_STORE_DUE_TO_SWITCH_FALLTHROUGH",
    abbreviation: "SF",
    category: "CORRECTNESS",
  },
  {
    type: "SF_DEAD_STORE_DUE_TO_SWITCH_FALLTHROUGH_TO_THROW",
    abbreviation: "SF",
    category: "CORRECTNESS",
  },
  {
    type: "SF_SWITCH_FALLTHROUGH",
    abbreviation: "SF",
    category: "STYLE",
  },
  {
    type: "SF_SWITCH_NO_DEFAULT",
    abbreviation: "SF",
    category: "STYLE",
  },
  {
    type: "SIC_INNER_SHOULD_BE_STATIC",
    abbreviation: "SIC",
    category: "PERFORMANCE",
  },
  {
    type: "SIC_INNER_SHOULD_BE_STATIC_ANON",
    abbreviation: "SIC",
    category: "PERFORMANCE",
  },
  {
    type: "SIC_INNER_SHOULD_BE_STATIC_NEEDS_THIS",
    abbreviation: "SIC",
    category: "PERFORMANCE",
  },
  {
    type: "SIC_THREADLOCAL_DEADLY_EMBRACE",
    abbreviation: "SIC",
    category: "CORRECTNESS",
  },
  {
    type: "SING_SINGLETON_GETTER_NOT_SYNCHRONIZED",
    abbreviation: "SING",
    category: "CORRECTNESS",
  },
  {
    type: "SING_SINGLETON_HAS_NONPRIVATE_CONSTRUCTOR",
    abbreviation: "SING",
    category: "CORRECTNESS",
  },
  {
    type: "SING_SINGLETON_IMPLEMENTS_CLONEABLE",
    abbreviation: "SING",
    category: "CORRECTNESS",
  },
  {
    type: "SING_SINGLETON_IMPLEMENTS_CLONE_METHOD",
    abbreviation: "SING",
    category: "CORRECTNESS",
  },
  {
    type: "SING_SINGLETON_IMPLEMENTS_SERIALIZABLE",
    abbreviation: "SING",
    category: "CORRECTNESS",
  },
  {
    type: "SING_SINGLETON_INDIRECTLY_IMPLEMENTS_CLONEABLE",
    abbreviation: "SING",
    category: "CORRECTNESS",
  },
  {
    type: "SIO_SUPERFLUOUS_INSTANCEOF",
    abbreviation: "SIO",
    category: "CORRECTNESS",
  },
  {
    type: "SI_INSTANCE_BEFORE_FINALS_ASSIGNED",
    abbreviation: "SI",
    category: "BAD_PRACTICE",
  },
  {
    type: "SKIPPED_CLASS_TOO_BIG",
    abbreviation: "SKIPPED",
    category: "EXPERIMENTAL",
  },
  {
    type: "SP_SPIN_ON_FIELD",
    abbreviation: "SP",
    category: "MT_CORRECTNESS",
  },
  {
    type: "SQL_BAD_PREPARED_STATEMENT_ACCESS",
    abbreviation: "SQL",
    category: "CORRECTNESS",
  },
  {
    type: "SQL_BAD_RESULTSET_ACCESS",
    abbreviation: "SQL",
    category: "CORRECTNESS",
  },
  {
    type: "SQL_NONCONSTANT_STRING_PASSED_TO_EXECUTE",
    abbreviation: "SQL",
    category: "SECURITY",
  },
  {
    type: "SQL_PREPARED_STATEMENT_GENERATED_FROM_NONCONSTANT_STRING",
    abbreviation: "SQL",
    category: "SECURITY",
  },
  {
    type: "SR_NOT_CHECKED",
    abbreviation: "RR",
    category: "BAD_PRACTICE",
  },
  {
    type: "SSD_DO_NOT_USE_INSTANCE_LOCK_ON_SHARED_STATIC_DATA",
    abbreviation: "SSD",
    category: "MT_CORRECTNESS",
  },
  {
    type: "SS_SHOULD_BE_STATIC",
    abbreviation: "SS",
    category: "PERFORMANCE",
  },
  {
    type: "STCAL_INVOKE_ON_STATIC_CALENDAR_INSTANCE",
    abbreviation: "STCAL",
    category: "MT_CORRECTNESS",
  },
  {
    type: "STCAL_INVOKE_ON_STATIC_DATE_FORMAT_INSTANCE",
    abbreviation: "STCAL",
    category: "MT_CORRECTNESS",
  },
  {
    type: "STCAL_STATIC_CALENDAR_INSTANCE",
    abbreviation: "STCAL",
    category: "MT_CORRECTNESS",
  },
  {
    type: "STCAL_STATIC_SIMPLE_DATE_FORMAT_INSTANCE",
    abbreviation: "STCAL",
    category: "MT_CORRECTNESS",
  },
  {
    type: "STI_INTERRUPTED_ON_CURRENTTHREAD",
    abbreviation: "STI",
    category: "CORRECTNESS",
  },
  {
    type: "STI_INTERRUPTED_ON_UNKNOWNTHREAD",
    abbreviation: "STI",
    category: "CORRECTNESS",
  },
  {
    type: "ST_WRITE_TO_STATIC_FROM_INSTANCE_METHOD",
    abbreviation: "ST",
    category: "STYLE",
  },
  {
    type: "SWL_SLEEP_WITH_LOCK_HELD",
    abbreviation: "SWL",
    category: "MT_CORRECTNESS",
  },
  {
    type: "SW_SWING_METHODS_INVOKED_IN_SWING_THREAD",
    abbreviation: "SW",
    category: "BAD_PRACTICE",
  },
  {
    type: "TESTING",
    abbreviation: "TEST",
    category: "EXPERIMENTAL",
  },
  {
    type: "TESTING1",
    abbreviation: "TEST",
    category: "EXPERIMENTAL",
  },
  {
    type: "TESTING2",
    abbreviation: "TEST",
    category: "EXPERIMENTAL",
  },
  {
    type: "TESTING3",
    abbreviation: "TEST",
    category: "EXPERIMENTAL",
  },
  {
    type: "THROWS_METHOD_THROWS_CLAUSE_BASIC_EXCEPTION",
    abbreviation: "THROWS",
    category: "BAD_PRACTICE",
  },
  {
    type: "THROWS_METHOD_THROWS_CLAUSE_THROWABLE",
    abbreviation: "THROWS",
    category: "BAD_PRACTICE",
  },
  {
    type: "THROWS_METHOD_THROWS_RUNTIMEEXCEPTION",
    abbreviation: "THROWS",
    category: "BAD_PRACTICE",
  },
  {
    type: "TLW_TWO_LOCK_WAIT",
    abbreviation: "TLW",
    category: "MT_CORRECTNESS",
  },
  {
    type: "TQ_ALWAYS_VALUE_USED_WHERE_NEVER_REQUIRED",
    abbreviation: "TQ",
    category: "CORRECTNESS",
  },
  {
    type: "TQ_COMPARING_VALUES_WITH_INCOMPATIBLE_TYPE_QUALIFIERS",
    abbreviation: "TQ",
    category: "CORRECTNESS",
  },
  {
    type: "TQ_EXPLICIT_UNKNOWN_SOURCE_VALUE_REACHES_ALWAYS_SINK",
    abbreviation: "TQ",
    category: "STYLE",
  },
  {
    type: "TQ_EXPLICIT_UNKNOWN_SOURCE_VALUE_REACHES_NEVER_SINK",
    abbreviation: "TQ",
    category: "STYLE",
  },
  {
    type: "TQ_MAYBE_SOURCE_VALUE_REACHES_ALWAYS_SINK",
    abbreviation: "TQ",
    category: "CORRECTNESS",
  },
  {
    type: "TQ_MAYBE_SOURCE_VALUE_REACHES_NEVER_SINK",
    abbreviation: "TQ",
    category: "CORRECTNESS",
  },
  {
    type: "TQ_NEVER_VALUE_USED_WHERE_ALWAYS_REQUIRED",
    abbreviation: "TQ",
    category: "CORRECTNESS",
  },
  {
    type: "TQ_UNKNOWN_VALUE_USED_WHERE_ALWAYS_STRICTLY_REQUIRED",
    abbreviation: "TQ",
    category: "CORRECTNESS",
  },
  {
    type: "UCF_USELESS_CONTROL_FLOW",
    abbreviation: "UCF",
    category: "STYLE",
  },
  {
    type: "UCF_USELESS_CONTROL_FLOW_NEXT_LINE",
    abbreviation: "UCF",
    category: "STYLE",
  },
  {
    type: "UC_USELESS_CONDITION",
    abbreviation: "UC",
    category: "STYLE",
  },
  {
    type: "UC_USELESS_CONDITION_TYPE",
    abbreviation: "UC",
    category: "STYLE",
  },
  {
    type: "UC_USELESS_OBJECT",
    abbreviation: "UC",
    category: "STYLE",
  },
  {
    type: "UC_USELESS_OBJECT_STACK",
    abbreviation: "UC",
    category: "STYLE",
  },
  {
    type: "UC_USELESS_VOID_METHOD",
    abbreviation: "UC",
    category: "STYLE",
  },
  {
    type: "UG_SYNC_SET_UNSYNC_GET",
    abbreviation: "UG",
    category: "MT_CORRECTNESS",
  },
  {
    type: "UI_INHERITANCE_UNSAFE_GETRESOURCE",
    abbreviation: "UI",
    category: "BAD_PRACTICE",
  },
  {
    type: "UL_UNRELEASED_LOCK",
    abbreviation: "UL",
    category: "MT_CORRECTNESS",
  },
  {
    type: "UL_UNRELEASED_LOCK_EXCEPTION_PATH",
    abbreviation: "UL",
    category: "MT_CORRECTNESS",
  },
  {
    type: "UMAC_UNCALLABLE_METHOD_OF_ANONYMOUS_CLASS",
    abbreviation: "UMAC",
    category: "CORRECTNESS",
  },
  {
    type: "UM_UNNECESSARY_MATH",
    abbreviation: "UM",
    category: "PERFORMANCE",
  },
  {
    type: "UNKNOWN",
    abbreviation: "TEST",
    category: "EXPERIMENTAL",
  },
  {
    type: "UNS_UNSAFE_CALL",
    abbreviation: "UNS",
    category: "SECURITY",
  },
  {
    type: "UPM_UNCALLED_PRIVATE_METHOD",
    abbreviation: "UPM",
    category: "PERFORMANCE",
  },
  {
    type: "URF_UNREAD_FIELD",
    abbreviation: "UrF",
    category: "PERFORMANCE",
  },
  {
    type: "URF_UNREAD_PUBLIC_OR_PROTECTED_FIELD",
    abbreviation: "UrF",
    category: "STYLE",
  },
  {
    type: "UR_UNINIT_READ",
    abbreviation: "UR",
    category: "CORRECTNESS",
  },
  {
    type: "UR_UNINIT_READ_CALLED_FROM_SUPER_CONSTRUCTOR",
    abbreviation: "UR",
    category: "CORRECTNESS",
  },
  {
    type: "USBC_UNSAFE_SYNCHRONIZATION_WITH_ACCESSIBLE_BACKING_COLLECTION",
    abbreviation: "USBC",
    category: "SECURITY",
  },
  {
    type: "USBC_UNSAFE_SYNCHRONIZATION_WITH_BACKING_COLLECTION",
    abbreviation: "USBC",
    category: "SECURITY",
  },
  {
    type: "USBC_UNSAFE_SYNCHRONIZATION_WITH_INHERITABLE_BACKING_COLLECTION",
    abbreviation: "USBC",
    category: "SECURITY",
  },
  {
    type: "USC_POTENTIAL_SECURITY_CHECK_BASED_ON_UNTRUSTED_SOURCE",
    abbreviation: "USC",
    category: "MALICIOUS_CODE",
  },
  {
    type: "USM_USELESS_ABSTRACT_METHOD",
    abbreviation: "USM",
    category: "STYLE",
  },
  {
    type: "USM_USELESS_SUBCLASS_METHOD",
    abbreviation: "USM",
    category: "STYLE",
  },
  {
    type: "USO_UNSAFE_ACCESSIBLE_OBJECT_SYNCHRONIZATION",
    abbreviation: "USO",
    category: "SECURITY",
  },
  {
    type: "USO_UNSAFE_EXPOSED_OBJECT_SYNCHRONIZATION",
    abbreviation: "USO",
    category: "SECURITY",
  },
  {
    type: "USO_UNSAFE_INHERITABLE_OBJECT_SYNCHRONIZATION",
    abbreviation: "USO",
    category: "SECURITY",
  },
  {
    type: "USO_UNSAFE_METHOD_SYNCHRONIZATION",
    abbreviation: "USO",
    category: "SECURITY",
  },
  {
    type: "USO_UNSAFE_OBJECT_SYNCHRONIZATION",
    abbreviation: "USO",
    category: "SECURITY",
  },
  {
    type: "USO_UNSAFE_STATIC_METHOD_SYNCHRONIZATION",
    abbreviation: "USO",
    category: "SECURITY",
  },
  {
    type: "US_USELESS_SUPPRESSION_ON_CLASS",
    abbreviation: "US",
    category: "STYLE",
  },
  {
    type: "US_USELESS_SUPPRESSION_ON_FIELD",
    abbreviation: "US",
    category: "STYLE",
  },
  {
    type: "US_USELESS_SUPPRESSION_ON_METHOD",
    abbreviation: "US",
    category: "STYLE",
  },
  {
    type: "US_USELESS_SUPPRESSION_ON_METHOD_PARAMETER",
    abbreviation: "US",
    category: "STYLE",
  },
  {
    type: "US_USELESS_SUPPRESSION_ON_PACKAGE",
    abbreviation: "US",
    category: "STYLE",
  },
  {
    type: "UUF_UNUSED_FIELD",
    abbreviation: "UuF",
    category: "PERFORMANCE",
  },
  {
    type: "UUF_UNUSED_PUBLIC_OR_PROTECTED_FIELD",
    abbreviation: "UuF",
    category: "STYLE",
  },
  {
    type: "UWF_FIELD_NOT_INITIALIZED_IN_CONSTRUCTOR",
    abbreviation: "UwF",
    category: "STYLE",
  },
  {
    type: "UWF_NULL_FIELD",
    abbreviation: "UwF",
    category: "CORRECTNESS",
  },
  {
    type: "UWF_UNWRITTEN_FIELD",
    abbreviation: "UwF",
    category: "CORRECTNESS",
  },
  {
    type: "UWF_UNWRITTEN_PUBLIC_OR_PROTECTED_FIELD",
    abbreviation: "UwF",
    category: "STYLE",
  },
  {
    type: "UW_UNCOND_WAIT",
    abbreviation: "UW",
    category: "MT_CORRECTNESS",
  },
  {
    type: "VA_FORMAT_STRING_USES_NEWLINE",
    abbreviation: "FS",
    category: "BAD_PRACTICE",
  },
  {
    type: "VA_PRIMITIVE_ARRAY_PASSED_TO_OBJECT_VARARG",
    abbreviation: "VA",
    category: "CORRECTNESS",
  },
  {
    type: "VO_VOLATILE_INCREMENT",
    abbreviation: "VO",
    category: "MT_CORRECTNESS",
  },
  {
    type: "VO_VOLATILE_REFERENCE_TO_ARRAY",
    abbreviation: "VO",
    category: "MT_CORRECTNESS",
  },
  {
    type: "VR_UNRESOLVABLE_REFERENCE",
    abbreviation: "VR",
    category: "CORRECTNESS",
  },
  {
    type: "VSC_VULNERABLE_SECURITY_CHECK_METHODS",
    abbreviation: "VSC",
    category: "MALICIOUS_CODE",
  },
  {
    type: "WA_AWAIT_NOT_IN_LOOP",
    abbreviation: "Wa",
    category: "MT_CORRECTNESS",
  },
  {
    type: "WA_NOT_IN_LOOP",
    abbreviation: "Wa",
    category: "MT_CORRECTNESS",
  },
  {
    type: "WL_USING_GETCLASS_RATHER_THAN_CLASS_LITERAL",
    abbreviation: "WL",
    category: "MT_CORRECTNESS",
  },
  {
    type: "WMI_WRONG_MAP_ITERATOR",
    abbreviation: "WMI",
    category: "PERFORMANCE",
  },
  {
    type: "WS_WRITEOBJECT_SYNC",
    abbreviation: "WS",
    category: "MT_CORRECTNESS",
  },
  {
    type: "XFB_XML_FACTORY_BYPASS",
    abbreviation: "XFB",
    category: "STYLE",
  },
  {
    type: "XSS_REQUEST_PARAMETER_TO_JSP_WRITER",
    abbreviation: "XSS",
    category: "SECURITY",
  },
  {
    type: "XSS_REQUEST_PARAMETER_TO_SEND_ERROR",
    abbreviation: "XSS",
    category: "SECURITY",
  },
  {
    type: "XSS_REQUEST_PARAMETER_TO_SERVLET_WRITER",
    abbreviation: "XSS",
    category: "SECURITY",
  },
] as const;
export const spotbugsCoreFactories = [
  {
    detector: "edu.umd.cs.findbugs.detect.AppendingToAnObjectOutputStream",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.AtomicityProblem",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.BadAppletConstructor",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.BadResultSetAccess",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.BadSyntaxForRegularExpression",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.BadUseOfReturnValue",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.BadlyOverriddenAdapter",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.BooleanReturnNull",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.BuildAccessMethodsDatabase",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.BuildInterproceduralCallGraph",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.BuildObligationPolicyDatabase",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.BuildStringPassthruGraph",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.CallToUnsupportedMethod",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.CalledMethods",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.CheckCalls",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.CheckExpectedWarnings",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.CheckImmutableAnnotation",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.CheckRelaxingNullnessAnnotation",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.CheckTypeQualifiers",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.CloneIdiom",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.ComparatorIdiom",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.ConfusedInheritance",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector:
      "edu.umd.cs.findbugs.detect.ConfusionBetweenInheritedAndOuterMethod",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.ConstructorThrow",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.CovariantArrayAssignment",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.CrossSiteScripting",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.DateFormatStringChecker",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.DefaultEncodingDetector",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.DoInsideDoPrivileged",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.DontAssertInstanceofInTests",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector:
      "edu.umd.cs.findbugs.detect.DontCatchIllegalMonitorStateException",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.DontCatchNullPointerException",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.DontIgnoreResultOfPutIfAbsent",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.DontReusePublicIdentifiers",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.DontUseEnum",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.DontUseFloatsAsLoopCounters",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.DroppedException",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.DumbMethodInvocations",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.DumbMethods",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.DuplicateBranches",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.EmptyZipFileEntry",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector:
      "edu.umd.cs.findbugs.detect.EqualsOperandShouldHaveClassCompatibleWithThis",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.ExplicitSerialization",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FieldItemSummary",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FinalizerNullsFields",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindArgumentAssertions",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindAssertionsWithSideEffects",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindBadCast2",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindBadEndOfStreamCheck",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindBadForLoop",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindBugsSummaryStats",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindCircularDependencies",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindComparatorProblems",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindDeadLocalStores",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindDoubleCheck",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindEmptySynchronizedBlock",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindFieldSelfAssignment",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindFinalizeInvocations",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindFloatEquality",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindFloatMath",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindHEmismatch",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindHiddenMethod",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindImproperSynchronization",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindInconsistentSync2",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindIncreasedAccessibilityOfMethods",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindInstanceLockOnSharedStaticData",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindJSR166LockMonitorenter",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindLocalSelfAssignment2",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindMaskedFields",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindMismatchedWaitOrNotify",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindNakedNotify",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindNoSideEffectMethods",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindNonSerializableStoreIntoSession",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector:
      "edu.umd.cs.findbugs.detect.FindNonSerializableValuePassedToWriteObject",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindNonShortCircuit",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindNullDeref",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector:
      "edu.umd.cs.findbugs.detect.FindNullDerefsInvolvingNonShortCircuitEvaluation",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindOpenStream",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindOverridableMethodCall",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector:
      "edu.umd.cs.findbugs.detect.FindPotentialSecurityCheckBasedOnUntrustedSource",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindPublicAttributes",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindPuzzlers",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindRefComparison",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindReturnRef",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindRoughConstants",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindRunInvocations",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindSelfComparison",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindSelfComparison2",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindSleepWithLockHeld",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindSpinLoop",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindSqlInjection",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindTwoLockWait",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindUncalledPrivateMethods",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindUnconditionalWait",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindUninitializedGet",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindUnrelatedTypesInGenericContainer",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindUnreleasedLock",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindUnsatisfiedObligation",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindUnsyncGet",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindUseOfNonSerializableValue",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindUselessControlFlow",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindUselessObjects",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FindVulnerableSecurityCheckMethods",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.FormatStringChecker",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector:
      "edu.umd.cs.findbugs.detect.FunctionsThatMightBeMistakenForProcedures",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.HugeSharedStringConstants",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.IDivResultCastToDouble",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.IncompatMask",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.InconsistentAnnotations",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.InefficientIndexOf",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.InefficientInitializationInsideLoop",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.InefficientMemberAccess",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.InefficientToArray",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.InfiniteLoop",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.InfiniteRecursiveLoop",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.InheritanceUnsafeGetResource",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.InitializationChain",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.InitializeNonnullFieldsInConstructor",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.InstantiateStaticClass",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.IntCast2LongAsInstant",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.InvalidJUnitTest",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.IteratorIdioms",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.LazyInit",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.LoadOfKnownNullValue",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.LostLoggerDueToWeakReference",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.MethodReturnCheck",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.Methods",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.MultipleInstantiationsOfSingletons",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.MultithreadedInstanceAccess",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.MutableEnum",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.MutableLock",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.MutableStaticFields",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.Naming",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.Noise",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.NoiseNullDeref",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.NoteAnnotationRetention",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.NoteCheckReturnValueAnnotations",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.NoteDirectlyRelevantTypeQualifiers",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.NoteJCIPAnnotation",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.NoteNonNullAnnotations",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.NoteNonnullReturnValues",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.NoteUnconditionalParamDerefs",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.NumberConstructor",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.OptionalReturnNull",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.OverridingEqualsNotSymmetrical",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector:
      "edu.umd.cs.findbugs.detect.OverridingMethodsMustInvokeSuperDetector",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.PermissionsSuper",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.PreferZeroLengthArrays",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.PublicSemaphores",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.QuestionableBooleanAssignment",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector:
      "edu.umd.cs.findbugs.detect.ReadOfInstanceFieldInMethodInvokedByConstructorInSuperclass",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.ReadReturnShouldBeChecked",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.RedundantConditions",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.RedundantInterfaces",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.ReflectionIncreaseAccessibility",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.ReflectiveClasses",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.RepeatedConditionals",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.ResolveAllReferences",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.ResourceInMultipleThreadsDetector",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.RuntimeExceptionCapture",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.SerializableIdiom",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.SharedVariableAtomicityDetector",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.StartInConstructor",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.StaticCalendarDetector",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.StringConcatenation",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.SuperfluousInstanceOf",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.SuspiciousThreadInterrupted",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.SwitchFallthrough",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector:
      "edu.umd.cs.findbugs.detect.SynchronizationOnSharedBuiltinConstant",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.SynchronizeAndNullCheckField",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.SynchronizeOnClassLiteralNotGetClass",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector:
      "edu.umd.cs.findbugs.detect.SynchronizingOnContentsOfFieldToProtectField",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.TestASM",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.TestDataflowAnalysis",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.TestingGround",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.TestingGround2",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.ThrowingExceptions",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.TrainFieldStoreTypes",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.TrainLongInstantfParams",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.TrainNonNullAnnotations",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.TrainUnconditionalDerefParams",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.URLProblems",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.UncallableMethodOfAnonymousClass",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.UnnecessaryEnvUsage",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.UnnecessaryMath",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.UnreadFields",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.UnsafeDetector",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.UselessSubclassMethod",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.UselessSuppressionDetector",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.VarArgsProblems",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.ViewCFG",
    enabled: false,
    defaultEnabled: false,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.VolatileUsage",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.WaitInLoop",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.WrongMapIterator",
    enabled: true,
    defaultEnabled: true,
  },
  {
    detector: "edu.umd.cs.findbugs.detect.XMLFactoryBypass",
    enabled: true,
    defaultEnabled: true,
  },
] as const;
