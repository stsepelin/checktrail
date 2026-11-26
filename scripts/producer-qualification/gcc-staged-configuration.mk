# These explicit outer targets retain debian/rules locale unexports, its
# rules.defs evaluation, recursive MAKELEVEL and original NJOBS forwarding.
.PHONY: checktrail-forward-phase checktrail-forward-configuration
checktrail-forward-phase:
	$(MAKE) $(NJOBS) -f debian/rules2 "$(CHECKTRAIL_GCC_TARGET)"
checktrail-forward-configuration:
	$(MAKE) $(NJOBS) -f debian/rules2 -f "$(CHECKTRAIL_GCC_FRAGMENT)" checktrail-print-configuration

# First-party fixed metadata target. The carrier explicitly runs this after
# source authentication/configure, in the selected offline producer container.
# No default/native build target is requested by this fragment.
.PHONY: checktrail-print-configuration
checktrail-print-configuration:
	$(file >/work/gcc-staged-configuration/build_type,$(build_type))
	$(file >/work/gcc-staged-configuration/distribution,$(distribution))
	$(file >/work/gcc-staged-configuration/distrelease,$(distrelease))
	$(file >/work/gcc-staged-configuration/DEB_HOST_ARCH,$(DEB_HOST_ARCH))
	$(file >/work/gcc-staged-configuration/DEB_TARGET_ARCH,$(DEB_TARGET_ARCH))
	$(file >/work/gcc-staged-configuration/DEB_BUILD_OPTIONS,$(DEB_BUILD_OPTIONS))
	$(file >/work/gcc-staged-configuration/DEB_BUILD_PROFILES,$(DEB_BUILD_PROFILES))
	$(file >/work/gcc-staged-configuration/DEB_STAGE,$(DEB_STAGE))
	$(file >/work/gcc-staged-configuration/single_package,$(single_package))
	$(file >/work/gcc-staged-configuration/with_base_only,$(with_base_only))
	$(file >/work/gcc-staged-configuration/with_check,$(with_check))
	$(file >/work/gcc-staged-configuration/with_jit,$(with_jit))
	$(file >/work/gcc-staged-configuration/with_offload_nvptx,$(with_offload_nvptx))
	$(file >/work/gcc-staged-configuration/with_offload_gcn,$(with_offload_gcn))
	$(file >/work/gcc-staged-configuration/with_hppa64,$(with_hppa64))
	$(file >/work/gcc-staged-configuration/with_cxx,$(with_cxx))
	$(file >/work/gcc-staged-configuration/with_ada,$(with_ada))
	$(file >/work/gcc-staged-configuration/bootstrap_target,$(bootstrap_target))
	$(file >/work/gcc-staged-configuration/CONFARGS,$(CONFARGS))
	$(file >/work/gcc-staged-configuration/flags_to_pass,$(flags_to_pass))
	$(file >/work/gcc-staged-configuration/configure_dependencies,$(configure_dependencies))
	$(file >/work/gcc-staged-configuration/build_dependencies,$(build_dependencies))
	$(file >/work/gcc-staged-configuration/build_arch_dependencies,$(build_arch_dependencies))
	$(file >/work/gcc-staged-configuration/build_indep_dependencies,$(build_indep_dependencies))
	$(file >/work/gcc-staged-configuration/install_dependencies,$(install_dependencies))
	$(file >/work/gcc-staged-configuration/check_dependencies,$(check_dependencies))
	$(file >/work/gcc-staged-configuration/SET_PATH,$(SET_PATH))
	$(file >/work/gcc-staged-configuration/SET_SHELL,$(SET_SHELL))
	$(file >/work/gcc-staged-configuration/SET_LOCPATH,$(SET_LOCPATH))
	$(file >/work/gcc-staged-configuration/CC,$(CC))
	$(file >/work/gcc-staged-configuration/CXX,$(CXX))
	$(file >/work/gcc-staged-configuration/STAGE1_CFLAGS,$(STAGE1_CFLAGS))
	$(file >/work/gcc-staged-configuration/STAGE1_LDFLAGS,$(STAGE1_LDFLAGS))
	$(file >/work/gcc-staged-configuration/BOOT_CFLAGS,$(BOOT_CFLAGS))
	$(file >/work/gcc-staged-configuration/BOOT_LDFLAGS,$(BOOT_LDFLAGS))
	$(file >/work/gcc-staged-configuration/CFLAGS_FOR_BUILD,$(CFLAGS_FOR_BUILD))
	$(file >/work/gcc-staged-configuration/CXXFLAGS_FOR_BUILD,$(CXXFLAGS_FOR_BUILD))
	$(file >/work/gcc-staged-configuration/LDFLAGS_FOR_BUILD,$(LDFLAGS_FOR_BUILD))
	$(file >/work/gcc-staged-configuration/CFLAGS_FOR_TARGET,$(CFLAGS_FOR_TARGET))
	$(file >/work/gcc-staged-configuration/CXXFLAGS_FOR_TARGET,$(CXXFLAGS_FOR_TARGET))
	$(file >/work/gcc-staged-configuration/LDFLAGS_FOR_TARGET,$(LDFLAGS_FOR_TARGET))
	$(file >/work/gcc-staged-configuration/NJOBS,$(NJOBS))
	$(file >/work/gcc-staged-configuration/NJOBS_TESTS,$(NJOBS_TESTS))
	$(foreach variable,$(flags_to_pass),$(file >/work/gcc-staged-configuration/flag-$(variable),$($(variable))))
	@printf '%s\n' 'CHECKTRAIL_GCC_CONFIGURATION_WRITTEN'
